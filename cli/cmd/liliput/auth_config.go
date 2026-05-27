package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/term"
)

type authConfig struct {
	Tokens map[string]savedToken `json:"tokens"`
}

type savedToken struct {
	Token     string `json:"token"`
	Username  string `json:"username,omitempty"`
	UpdatedAt string `json:"updatedAt"`
}

func normalizedServerKey(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("server URL is required")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}

	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("unsupported server URL scheme %q", u.Scheme)
	}

	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", fmt.Errorf("server URL host is required")
	}
	port := u.Port()
	if port != "" && !isDefaultPort(scheme, port) {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}

	u.Scheme = scheme
	u.Host = host
	u.Path = ""
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	u.User = nil
	return strings.TrimRight(u.String(), "/"), nil
}

func isDefaultPort(scheme, port string) bool {
	return (scheme == "http" && port == "80") || (scheme == "https" && port == "443")
}

func authConfigPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "liliput", "config.json"), nil
}

func loadAuthConfig() (authConfig, error) {
	cfg := authConfig{Tokens: map[string]savedToken{}}
	path, err := authConfigPath()
	if err != nil {
		return cfg, err
	}

	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}
	if cfg.Tokens == nil {
		cfg.Tokens = map[string]savedToken{}
	}
	return cfg, nil
}

func writeAuthConfig(cfg authConfig) error {
	path, err := authConfigPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if cfg.Tokens == nil {
		cfg.Tokens = map[string]savedToken{}
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
			return err
		}
		return os.Rename(tmp, path)
	}
	return nil
}

func loadSavedToken(server string) (savedToken, bool, error) {
	key, err := normalizedServerKey(server)
	if err != nil {
		return savedToken{}, false, err
	}
	cfg, err := loadAuthConfig()
	if err != nil {
		return savedToken{}, false, err
	}
	token, ok := cfg.Tokens[key]
	return token, ok, nil
}

func saveToken(server, username, token string) error {
	key, err := normalizedServerKey(server)
	if err != nil {
		return err
	}
	cfg, err := loadAuthConfig()
	if err != nil {
		return err
	}
	cfg.Tokens[key] = savedToken{
		Token:     token,
		Username:  username,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	return writeAuthConfig(cfg)
}

func deleteSavedToken(server string) error {
	key, err := normalizedServerKey(server)
	if err != nil {
		return err
	}
	cfg, err := loadAuthConfig()
	if err != nil {
		return err
	}
	delete(cfg.Tokens, key)
	return writeAuthConfig(cfg)
}

func promptUsername(defaultUsername string) (string, error) {
	if strings.TrimSpace(defaultUsername) != "" {
		return strings.TrimSpace(defaultUsername), nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", fmt.Errorf("username is required; pass --username or set LILIPUT_USERNAME")
	}
	fmt.Fprint(os.Stderr, "Liliput username: ")
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return "", err
	}
	username := strings.TrimSpace(line)
	if username == "" {
		return "", fmt.Errorf("username is required")
	}
	return username, nil
}

func promptPassword() (string, error) {
	if password := os.Getenv("LILIPUT_PASSWORD"); password != "" {
		return password, nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", fmt.Errorf("password is required; set LILIPUT_PASSWORD for non-interactive login")
	}
	fmt.Fprint(os.Stderr, "Liliput password: ")
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	password := string(b)
	if password == "" {
		return "", fmt.Errorf("password is required")
	}
	return password, nil
}
