package ui

import (
	"fmt"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/crgarcia12/liliput/cli/internal/client"
)

func TestTasksModelShouldScrollTaskListWithMouseWheel(t *testing.T) {
	// Validates: specs/liliput/frd-cli-tui-navigation.md, AC-1.
	model := newTasksModel(nil)
	model.SetSize(100, 12)

	loaded, _ := model.Update(tasksLoadedMsg{tasks: testTasks(20)})
	model = loaded.(*tasksModel)

	if got := model.tbl.Cursor(); got != 0 {
		t.Fatalf("expected cursor to start at first task, got %d", got)
	}

	updated, _ := model.Update(tea.MouseMsg{
		Type:   tea.MouseWheelDown,
		Button: tea.MouseButtonWheelDown,
		Action: tea.MouseActionPress,
	})
	model = updated.(*tasksModel)

	if got := model.tbl.Cursor(); got == 0 {
		t.Fatalf("expected mouse wheel down to move task-list cursor, got %d", got)
	}
}

func TestDetailModelShouldScrollFocusedPaneWithMouseWheel(t *testing.T) {
	// Validates: specs/liliput/frd-cli-tui-navigation.md, AC-3.
	model := newDetailModel(nil, "task-1")
	model.SetSize(100, 30)
	model.task = &client.Task{ID: "task-1", Title: "Scrollable task", Status: "running"}
	model.focus = focusChat

	for i := range 80 {
		model.chat = append(model.chat, client.ChatMessage{
			Role:    "agent",
			Content: fmt.Sprintf("message %02d", i),
		})
	}
	model.refreshPanes()

	bottom := model.chatVP.YOffset
	if bottom == 0 {
		t.Fatal("test setup expected chat viewport to overflow")
	}

	updated, _ := model.Update(tea.MouseMsg{
		Type:   tea.MouseWheelUp,
		Button: tea.MouseButtonWheelUp,
		Action: tea.MouseActionPress,
	})
	model = updated.(*detailModel)

	if got := model.chatVP.YOffset; got >= bottom {
		t.Fatalf("expected mouse wheel up to scroll chat pane above bottom offset %d, got %d", bottom, got)
	}
}

func testTasks(count int) []client.Task {
	tasks := make([]client.Task, 0, count)
	now := time.Now()
	for i := range count {
		ts := now.Add(time.Duration(-i) * time.Minute).Format(time.RFC3339)
		tasks = append(tasks, client.Task{
			ID:         fmt.Sprintf("task-%02d", i),
			Title:      fmt.Sprintf("Task %02d", i),
			Status:     "running",
			Repository: "crgarcia12/liliput",
			CreatedAt:  ts,
			UpdatedAt:  ts,
		})
	}
	return tasks
}
