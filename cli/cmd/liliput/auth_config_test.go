package main

import "testing"

func TestNormalizedServerKey(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "lowercases host and strips trailing slash",
			raw:  "https://LILIPUT.crgarcia.com.ar/",
			want: "https://liliput.crgarcia.com.ar",
		},
		{
			name: "drops default https port",
			raw:  "https://liliput.crgarcia.com.ar:443/tasks?x=1#frag",
			want: "https://liliput.crgarcia.com.ar",
		},
		{
			name: "keeps non-default port",
			raw:  "http://LOCALHOST:5001/api",
			want: "http://localhost:5001",
		},
		{
			name: "adds https scheme when missing",
			raw:  "dev.liliput.crgarcia.com.ar",
			want: "https://dev.liliput.crgarcia.com.ar",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizedServerKey(tt.raw)
			if err != nil {
				t.Fatalf("normalizedServerKey() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("normalizedServerKey() = %q, want %q", got, tt.want)
			}
		})
	}
}
