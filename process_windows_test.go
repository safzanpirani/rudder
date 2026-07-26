//go:build windows

package main

import (
	"reflect"
	"testing"
)

func TestWindowsTaskkillArgsTerminateProcessTree(t *testing.T) {
	got := windowsTaskkillArgs(1234)
	want := []string{"/PID", "1234", "/T", "/F"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("windowsTaskkillArgs() = %#v, want %#v", got, want)
	}
}
