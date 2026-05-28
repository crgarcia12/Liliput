package client

import "testing"

func TestNewShouldAddHTTPSWhenServerURLHasNoScheme(t *testing.T) {
	// Validates: specs/frd-auth.md, §4 Authentication Flow.
	c := New("dev.liliput.crgarcia.com.ar")

	if got, want := c.BaseURL(), "https://dev.liliput.crgarcia.com.ar"; got != want {
		t.Fatalf("New().BaseURL() = %q, want %q", got, want)
	}
}
