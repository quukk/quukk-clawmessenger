package agent

import (
	"errors"
	"strings"
)

// InteractiveModelSelector maps only identities established by the adapter's
// catalog. Unknown Codex providers must not silently select the default account.
func InteractiveModelSelector(provider, model string) (string, error) {
	if model == "" {
		return "", nil
	}
	if provider == "codex" {
		for _, entry := range codexStaticModels() {
			if model == entry.ID || model == entry.Provider+"/"+entry.ID {
				return entry.ID, nil
			}
		}
		return "", errors.New("Codex task model is not in the verified model catalog; choose a supported OpenAI model")
	}
	if strings.Count(model, "/") != 1 || strings.HasPrefix(model, "/") || strings.HasSuffix(model, "/") {
		return "", errors.New("task model requires canonical provider/model")
	}
	switch provider {
	case "opencode", "hermes", "openclaw":
		return model, nil
	}
	return "", errors.New("task model selection unsupported for runtime")
}
