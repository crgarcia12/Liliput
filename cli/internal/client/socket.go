package client

// Socket.IO v4 client implementing Engine.IO v4 + Socket.IO v4 framing on top
// of gorilla/websocket. We don't need polling — Socket.IO clients are allowed
// to start directly on the websocket transport with `transport=websocket`.
//
// Frame syntax we care about (Engine.IO packet types are single ASCII digits):
//   0  open      server → client (handshake JSON payload)
//   1  close
//   2  ping
//   3  pong
//   4  message   wraps a Socket.IO packet
// Inside a `4` (message) frame the first char is a Socket.IO packet type:
//   0  CONNECT          {"sid":"..."}
//   1  DISCONNECT
//   2  EVENT            ["event", arg1, arg2, ...]
//   3  ACK
//
// So a server event arrives as the websocket text frame:   42["task:status",{...}]
// The client connect packet we send right after the open is just:   40

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// SocketEvent is a single Socket.IO event with its raw JSON payload.
type SocketEvent struct {
	Name string
	Data json.RawMessage // first arg of the event array — usually an object
}

// Socket is a long-lived Socket.IO connection that auto-reconnects.
type Socket struct {
	baseURL string

	mu        sync.Mutex
	conn      *websocket.Conn
	connected bool
	subTask   string // task id we want subscribed (re-applied on reconnect)
	closed    bool

	events chan SocketEvent
	status chan string // "connected" / "disconnected: <reason>"
}

func NewSocket(baseURL string) *Socket {
	return &Socket{
		baseURL: baseURL,
		events:  make(chan SocketEvent, 256),
		status:  make(chan string, 16),
	}
}

func (s *Socket) Events() <-chan SocketEvent { return s.events }
func (s *Socket) Status() <-chan string      { return s.status }

// SubscribeTask asks the server to add us to the given task room. Re-applied on every reconnect.
func (s *Socket) SubscribeTask(taskID string) {
	s.mu.Lock()
	s.subTask = taskID
	conn := s.conn
	connected := s.connected
	s.mu.Unlock()
	if connected && conn != nil {
		_ = sendEvent(conn, "subscribe:task", taskID)
	}
}

// Run blocks until ctx is done, reconnecting on failure with exponential backoff.
func (s *Socket) Run(ctx context.Context) {
	backoff := 3 * time.Second
	const maxBackoff = 30 * time.Second

	for {
		if ctx.Err() != nil {
			return
		}
		err := s.dialAndPump(ctx)
		s.mu.Lock()
		s.connected = false
		s.conn = nil
		closed := s.closed
		s.mu.Unlock()
		if closed || ctx.Err() != nil {
			return
		}
		s.pushStatus(fmt.Sprintf("disconnected: %v", err))
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// Close terminates the socket and prevents further reconnects.
func (s *Socket) Close() {
	s.mu.Lock()
	s.closed = true
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (s *Socket) pushStatus(msg string) {
	select {
	case s.status <- msg:
	default:
	}
}

func (s *Socket) dialAndPump(ctx context.Context) error {
	wsURL, err := buildWSURL(s.baseURL)
	if err != nil {
		return err
	}

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second

	conn, resp, err := dialer.DialContext(ctx, wsURL, http.Header{})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("ws dial %s: %w (status=%s)", wsURL, err, resp.Status)
		}
		return fmt.Errorf("ws dial %s: %w", wsURL, err)
	}
	defer conn.Close()

	// Engine.IO open: server sends `0{"sid":"...","pingInterval":...,"pingTimeout":...}`
	conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	mt, raw, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("read open: %w", err)
	}
	if mt != websocket.TextMessage || len(raw) == 0 || raw[0] != '0' {
		return fmt.Errorf("unexpected open frame: %q", string(raw))
	}

	var open struct {
		PingInterval int `json:"pingInterval"`
		PingTimeout  int `json:"pingTimeout"`
	}
	_ = json.Unmarshal(raw[1:], &open)
	if open.PingInterval <= 0 {
		open.PingInterval = 25000
	}
	if open.PingTimeout <= 0 {
		open.PingTimeout = 20000
	}

	// Socket.IO CONNECT to default namespace.
	if err := conn.WriteMessage(websocket.TextMessage, []byte("40")); err != nil {
		return fmt.Errorf("write 40: %w", err)
	}

	s.mu.Lock()
	s.conn = conn
	s.connected = true
	subTask := s.subTask
	s.mu.Unlock()

	s.pushStatus("connected")
	if subTask != "" {
		_ = sendEvent(conn, "subscribe:task", subTask)
	}

	// Read loop. The server sends ping frames; we reply with pong.
	deadline := time.Duration(open.PingInterval+open.PingTimeout) * time.Millisecond
	for {
		conn.SetReadDeadline(time.Now().Add(deadline))
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if mt != websocket.TextMessage || len(msg) == 0 {
			continue
		}
		switch msg[0] {
		case '2': // ping
			if err := conn.WriteMessage(websocket.TextMessage, []byte("3")); err != nil {
				return err
			}
		case '4': // Socket.IO message frame
			if len(msg) < 2 {
				continue
			}
			// msg[1] is the Socket.IO packet type
			if msg[1] == '0' {
				// CONNECT ack — already accepted, sid is in payload
				continue
			}
			if msg[1] == '2' {
				// EVENT — payload after the digit (and optional ack id) is a JSON array.
				idx := 2
				for idx < len(msg) && msg[idx] >= '0' && msg[idx] <= '9' {
					idx++
				}
				payload := msg[idx:]
				name, data, ok := parseEvent(payload)
				if !ok {
					continue
				}
				select {
				case s.events <- SocketEvent{Name: name, Data: data}:
				default:
					// Drop oldest if buffer full.
					select {
					case <-s.events:
					default:
					}
					s.events <- SocketEvent{Name: name, Data: data}
				}
			}
		case '1': // server close
			return errors.New("server closed connection")
		}
	}
}

func buildWSURL(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
		// keep
	default:
		return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/socket.io/"
	q := u.Query()
	q.Set("EIO", "4")
	q.Set("transport", "websocket")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func sendEvent(conn *websocket.Conn, name string, args ...any) error {
	arr := append([]any{name}, args...)
	body, err := json.Marshal(arr)
	if err != nil {
		return err
	}
	frame := append([]byte("42"), body...)
	return conn.WriteMessage(websocket.TextMessage, frame)
}

// parseEvent decodes ["name", payload] into (name, raw payload).
func parseEvent(b []byte) (string, json.RawMessage, bool) {
	var arr []json.RawMessage
	if err := json.Unmarshal(b, &arr); err != nil || len(arr) == 0 {
		return "", nil, false
	}
	var name string
	if err := json.Unmarshal(arr[0], &name); err != nil {
		return "", nil, false
	}
	if len(arr) > 1 {
		return name, arr[1], true
	}
	return name, json.RawMessage("null"), true
}
