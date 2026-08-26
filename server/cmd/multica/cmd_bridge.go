package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon"
	"github.com/spf13/cobra"
)

const bridgeCommandStartupLimit int64 = 65_536

var (
	errBridgeCommandInvalidStartup = errors.New("invalid bridge startup configuration")
	errBridgeCommandVersion        = errors.New("bridge startup version does not match binary")
	errBridgeCommandRandom         = errors.New("could not generate bridge process identity")
	errBridgeCommandListener       = errors.New("could not bind bridge loopback listener")
	errBridgeCommandReadiness      = errors.New("bridge readiness was not completed")
)

type bridgeCommandStartup struct {
	Secret                string            `json:"secret"`
	InstallID             string            `json:"install_id"`
	Version               string            `json:"version"`
	ProviderPathOverrides map[string]string `json:"provider_path_overrides"`
}

type bridgeCommandDeps struct {
	listen func(string, string) (net.Listener, error)
	now    func() time.Time
	pid    func() int
	random io.Reader
	serve  func(context.Context, net.Listener, daemon.BridgeHTTPConfig) error
}

func defaultBridgeCommandDeps() bridgeCommandDeps {
	return bridgeCommandDeps{
		listen: net.Listen,
		now:    time.Now,
		pid:    os.Getpid,
		random: rand.Reader,
		serve:  daemon.ServeBridgeHTTP,
	}
}

func newBridgeCommand(deps bridgeCommandDeps) *cobra.Command {
	defaults := defaultBridgeCommandDeps()
	if deps.listen == nil {
		deps.listen = defaults.listen
	}
	if deps.now == nil {
		deps.now = defaults.now
	}
	if deps.pid == nil {
		deps.pid = defaults.pid
	}
	if deps.random == nil {
		deps.random = defaults.random
	}
	if deps.serve == nil {
		deps.serve = defaults.serve
	}
	return &cobra.Command{
		Use:           "bridge",
		Hidden:        true,
		SilenceUsage:  true,
		SilenceErrors: true,
		Args: func(_ *cobra.Command, args []string) error {
			if len(args) != 0 {
				return errBridgeCommandInvalidStartup
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runBridgeCommand(cmd, deps)
		},
	}
}

func init() {
	daemonCmd.AddCommand(newBridgeCommand(defaultBridgeCommandDeps()))
}

func runBridgeCommand(cmd *cobra.Command, deps bridgeCommandDeps) error {
	startup, err := decodeBridgeCommandStartup(cmd.InOrStdin())
	if err != nil {
		return err
	}
	if startup.Version != version {
		return errBridgeCommandVersion
	}

	var randomBytes [16]byte
	if _, err := io.ReadFull(deps.random, randomBytes[:]); err != nil {
		return errBridgeCommandRandom
	}
	instanceID := "br_" + hex.EncodeToString(randomBytes[:])
	startedAt := deps.now().UTC()
	pid := deps.pid()

	listener, err := deps.listen("tcp4", "127.0.0.1:0")
	if err != nil || listener == nil {
		return errBridgeCommandListener
	}
	defer listener.Close()
	address, ok := bridgeCommandListenerAddress(listener)
	if !ok {
		return errBridgeCommandListener
	}

	readiness, err := json.Marshal(struct {
		Address    string    `json:"address"`
		PID        int       `json:"pid"`
		Version    string    `json:"version"`
		InstanceID string    `json:"instance_id"`
		StartedAt  time.Time `json:"started_at"`
	}{address, pid, startup.Version, instanceID, startedAt})
	if err != nil {
		return errBridgeCommandReadiness
	}
	readiness = append(readiness, '\n')
	var ready atomic.Bool

	root, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = deps.serve(root, listener, daemon.BridgeHTTPConfig{
		Secret:                startup.Secret,
		InstallID:             startup.InstallID,
		Version:               startup.Version,
		ProviderPathOverrides: startup.ProviderPathOverrides,
		PID:                   pid,
		InstanceID:            instanceID,
		StartedAt:             startedAt,
		Ready: func() error {
			if !ready.CompareAndSwap(false, true) {
				return errBridgeCommandReadiness
			}
			written, err := cmd.OutOrStdout().Write(readiness)
			if err != nil || written != len(readiness) {
				return errBridgeCommandReadiness
			}
			return nil
		},
	})
	if err != nil {
		return err
	}
	if !ready.Load() {
		return errBridgeCommandReadiness
	}
	return nil
}

func decodeBridgeCommandStartup(reader io.Reader) (bridgeCommandStartup, error) {
	var startup bridgeCommandStartup
	data, err := io.ReadAll(io.LimitReader(reader, bridgeCommandStartupLimit+1))
	if err != nil || len(data) == 0 || int64(len(data)) > bridgeCommandStartupLimit {
		return startup, errBridgeCommandInvalidStartup
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&startup); err != nil {
		return bridgeCommandStartup{}, errBridgeCommandInvalidStartup
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return bridgeCommandStartup{}, errBridgeCommandInvalidStartup
	}
	if !bridgeCommandExactNonEmpty(startup.Secret) || !bridgeCommandExactNonEmpty(startup.InstallID) || !bridgeCommandExactNonEmpty(startup.Version) {
		return bridgeCommandStartup{}, errBridgeCommandInvalidStartup
	}
	for provider := range startup.ProviderPathOverrides {
		switch provider {
		case "opencode", "openclaw", "codex", "hermes":
		default:
			return bridgeCommandStartup{}, errBridgeCommandInvalidStartup
		}
	}
	return startup, nil
}

func bridgeCommandExactNonEmpty(value string) bool {
	return value != "" && strings.TrimSpace(value) == value
}

func bridgeCommandListenerAddress(listener net.Listener) (string, bool) {
	if listener.Addr() == nil {
		return "", false
	}
	address := listener.Addr().String()
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return "", false
	}
	ip := net.ParseIP(host)
	return address, ip != nil && ip.To4() != nil && ip.IsLoopback()
}
