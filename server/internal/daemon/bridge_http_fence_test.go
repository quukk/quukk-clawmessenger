package daemon

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestBridgeHTTPFenceRejectsUnconfirmedAndReturnsTerminalSession(t *testing.T) {
	for _, failed := range []bool{false, true} {
		handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{
			fenceTask: func(context.Context, string) (string, error) {
				if failed {
					return "", errors.New("unconfirmed")
				}
				return "cancelled", nil
			},
			terminalSession: func(string) string { return "saved-session" },
		})
		response := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/tasks/task_123_a/fence", nil))
		if failed {
			if response.Code != 409 {
				t.Fatalf("unconfirmed %d %s", response.Code, response.Body.String())
			}
		} else if response.Code != 200 || response.Body.String() != "{\"result\":\"cancelled\",\"session_id\":\"saved-session\"}\n" {
			t.Fatalf("proof %d %s", response.Code, response.Body.String())
		}
	}
}

func TestBridgeHTTPFenceProof(t *testing.T) {
	handler := newBridgeHTTPPhase1Handler(t, bridgeHTTPDeps{fenceTask: func(ctx context.Context, id string) (string, error) {
		if id != "task_123_a" {
			t.Fatalf("wrong target: %s", id)
		}
		return "not_started", nil
	}})
	response := bridgeHTTPDo(handler, bridgeHTTPAuthorizedRequest(http.MethodPost, "/v1/tasks/task_123_a/fence", nil))
	if response.Code != 200 || response.Body.String() != "{\"result\":\"not_started\"}\n" {
		t.Fatalf("proof: %d %s", response.Code, response.Body.String())
	}
}
