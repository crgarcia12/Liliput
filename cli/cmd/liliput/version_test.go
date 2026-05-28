package main

import "testing"

func TestCLIVersionShouldUseCodebaseVersion(t *testing.T) {
	if cliVersion != "0.0.87" {
		t.Fatalf("cliVersion = %q, want %q", cliVersion, "0.0.87")
	}
}
