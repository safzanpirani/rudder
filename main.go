package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const version = "0.1.0"

func main() {
	ctx := context.Background()
	stop := func() {}
	if len(os.Args) > 1 && os.Args[1] == "run" {
		ctx, stop = signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	}
	defer stop()
	if err := runCLIContext(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "rudder:", err)
		os.Exit(1)
	}
}

func runCLI(args []string) error {
	return runCLIContext(context.Background(), args)
}

func runCLIContext(ctx context.Context, args []string) error {
	if len(args) == 0 {
		printUsage()
		return errors.New("a command is required")
	}
	switch args[0] {
	case "run":
		return runCommandContext(ctx, args[1:])
	case "thread":
		return threadCommand(args[1:])
	case "steer":
		return steerCommand(args[1:])
	case "status":
		return statusCommand(args[1:])
	case "peek":
		return peekCommand(args[1:])
	case "interrupt":
		return interruptCommand(args[1:])
	case "wait":
		return waitCommand(args[1:])
	case "version", "--version", "-version":
		fmt.Println("codex-rudder", version)
		return nil
	case "help", "--help", "-h":
		printUsage()
		return nil
	default:
		printUsage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runCommand(args []string) error {
	return runCommandContext(context.Background(), args)
}

func runCommandContext(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	cwd, _ := os.Getwd()
	var cfg runConfig
	fs.StringVar(&cfg.CWD, "cwd", cwd, "working directory for the Codex thread")
	fs.StringVar(&cfg.PromptFile, "prompt-file", "", "file containing the initial task")
	fs.StringVar(&cfg.StateDir, "state-dir", "", "directory for state, trace, and output")
	fs.StringVar(&cfg.Model, "model", "gpt-5.6-sol", "Codex model")
	fs.StringVar(&cfg.Effort, "effort", "", "reasoning effort override")
	fs.StringVar(&cfg.Sandbox, "sandbox", "workspace-write", "read-only, workspace-write, or danger-full-access")
	fs.StringVar(&cfg.ApprovalPolicy, "approval-policy", "never", "Codex approval policy")
	fs.BoolVar(&cfg.Ephemeral, "ephemeral", false, "do not persist the Codex thread")
	fs.StringVar(&cfg.ResumeThreadID, "resume-thread", "", "resume this thread before starting the turn")
	fs.StringVar(&cfg.ForkThreadID, "fork-thread", "", "fork this thread before starting the turn")
	fs.StringVar(&cfg.ForkBeforeTurnID, "fork-before-turn", "", "when forking, exclude this turn and everything after it")
	fs.StringVar(&cfg.ForkThroughTurnID, "fork-through-turn", "", "when forking, include history through this turn")
	fs.DurationVar(&cfg.TurnTimeout, "turn-timeout", time.Hour, "maximum active turn duration; zero disables the watchdog")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if cfg.PromptFile == "" {
		return errors.New("--prompt-file is required")
	}
	if cfg.StateDir == "" {
		return errors.New("--state-dir is required")
	}
	if fs.NArg() > 0 {
		cfg.ChildCommand = fs.Args()
	} else {
		cfg.ChildCommand = []string{"codex", "app-server", "--listen", "stdio://"}
	}
	return runControllerContext(ctx, cfg)
}

func steerCommand(args []string) error {
	fs := flag.NewFlagSet("steer", flag.ContinueOnError)
	var stateDir, messageFile string
	var timeout time.Duration
	fs.StringVar(&stateDir, "state-dir", "", "Rudder run state directory")
	fs.StringVar(&messageFile, "message-file", "", "read steering text from this file")
	fs.DurationVar(&timeout, "timeout", 30*time.Second, "control request timeout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if stateDir == "" {
		return errors.New("--state-dir is required")
	}
	var message string
	if messageFile != "" {
		raw, err := os.ReadFile(messageFile)
		if err != nil {
			return err
		}
		message = strings.TrimSpace(string(raw))
	} else {
		message = strings.TrimSpace(strings.Join(fs.Args(), " "))
	}
	if message == "" {
		return errors.New("steering text is required")
	}
	state, err := readState(stateDir)
	if err != nil {
		return err
	}
	state = displayedState(state)
	if state.Status != "active" {
		return fmt.Errorf("turn is not steerable: status=%s", state.Status)
	}
	response, err := sendControl(stateDir, controlRequest{Command: "steer", Text: message}, timeout)
	if err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Error)
	}
	fmt.Printf("steered turn %s\n", response.State.TurnID)
	return nil
}

func statusCommand(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	var stateDir string
	var asJSON bool
	fs.StringVar(&stateDir, "state-dir", "", "Rudder run state directory")
	fs.BoolVar(&asJSON, "json", false, "print full state as JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	state, err := readState(stateDir)
	if err != nil {
		return err
	}
	state = displayedState(state)
	if asJSON {
		return printJSON(state)
	}
	fmt.Printf("%s thread=%s turn=%s pid=%d steers=%d\n", state.Status, state.ThreadID, state.TurnID, state.PID, state.Steers)
	if state.Error != "" {
		fmt.Println("error:", state.Error)
	}
	return nil
}

func peekCommand(args []string) error {
	fs := flag.NewFlagSet("peek", flag.ContinueOnError)
	var stateDir string
	var count int
	fs.StringVar(&stateDir, "state-dir", "", "Rudder run state directory")
	fs.IntVar(&count, "n", 25, "number of trace lines")
	if err := fs.Parse(args); err != nil {
		return err
	}
	state, err := readState(stateDir)
	if err != nil {
		return err
	}
	lines, err := tailLines(state.TracePath, count)
	if err != nil {
		return err
	}
	for _, line := range lines {
		fmt.Println(line)
	}
	return nil
}

func interruptCommand(args []string) error {
	fs := flag.NewFlagSet("interrupt", flag.ContinueOnError)
	var stateDir string
	var timeout time.Duration
	fs.StringVar(&stateDir, "state-dir", "", "Rudder run state directory")
	fs.DurationVar(&timeout, "timeout", 30*time.Second, "control request timeout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	state, err := readState(stateDir)
	if err != nil {
		return err
	}
	state = displayedState(state)
	if state.Status != "active" {
		return fmt.Errorf("turn is not active: status=%s", state.Status)
	}
	response, err := sendControl(stateDir, controlRequest{Command: "interrupt"}, timeout)
	if err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Error)
	}
	fmt.Printf("interrupt requested for turn %s\n", response.State.TurnID)
	return nil
}

func waitCommand(args []string) error {
	fs := flag.NewFlagSet("wait", flag.ContinueOnError)
	var stateDir string
	var timeout time.Duration
	fs.StringVar(&stateDir, "state-dir", "", "Rudder run state directory")
	fs.DurationVar(&timeout, "timeout", 0, "maximum wait; zero means no limit")
	if err := fs.Parse(args); err != nil {
		return err
	}
	deadline := time.Time{}
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, err := readState(stateDir)
		if err != nil {
			return err
		}
		if terminalStatus(state.Status) {
			fmt.Println(state.Status)
			if state.Status == "completed" {
				return nil
			}
			if state.Error != "" {
				return errors.New(state.Error)
			}
			return fmt.Errorf("turn ended with status %s", state.Status)
		}
		if !processAlive(state.PID) {
			return fmt.Errorf("Rudder pid %d is not running; state is stale at status=%s", state.PID, state.Status)
		}
		if !deadline.IsZero() && time.Now().After(deadline) {
			return errors.New("wait timed out")
		}
		<-ticker.C
	}
}

func printUsage() {
	name := filepath.Base(os.Args[0])
	fmt.Fprintf(os.Stderr, `Codex Rudder - live steering for codex app-server

Usage:
  %s run --prompt-file FILE --state-dir DIR [options] [-- APP_SERVER_COMMAND...]
  %s thread list|search|read|turns|fork|name|archive|unarchive [options]
  %s steer --state-dir DIR "new direction"
  %s status --state-dir DIR [--json]
  %s peek --state-dir DIR [-n 25]
  %s interrupt --state-dir DIR
  %s wait --state-dir DIR [--timeout 10m]
`, name, name, name, name, name, name, name)
}
