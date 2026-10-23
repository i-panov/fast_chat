package transport

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/config"
	"fast_chat/internal/turn"
)

// RegisterICE adds the ICE configuration endpoint. The configuration carries
// the TURN credentials, so the endpoint requires a bearer token: the public
// /api/config would hand them to anonymous visitors.
func RegisterICE(api huma.API, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "get-ice-servers",
		Method:      http.MethodGet,
		Path:        "/api/ice",
		Summary:     "ICE servers for WebRTC",
		Security:    []map[string][]string{{bearerScheme: {}}},
	}, func(ctx context.Context, _ *struct{}) (*iceOutput, error) {
		user, ok := userFromContext(ctx)
		if !ok {
			return nil, errUnauthorized
		}

		return &iceOutput{Body: iceServers(cfg.ICE, user.ID, time.Now())}, nil
	})
}

// iceServers builds the ICE configuration of one client. A relay with the
// secret of the TURN REST API gets the short-lived credentials of the user:
// the secret itself never leaves the server, and a copied password stops
// working when the call is over. A relay with static credentials is handed
// over as it is configured.
func iceServers(cfg config.ICEConfig, userID string, now time.Time) config.ICEConfig {
	out := config.ICEConfig{
		STUN: cfg.STUN,
		TURN: make([]config.TURNServer, 0, len(cfg.TURN)),
	}

	for _, server := range cfg.TURN {
		if server.Secret == "" {
			out.TURN = append(out.TURN, config.TURNServer{
				URLs:       server.URLs,
				Username:   server.Username,
				Credential: server.Credential,
			})

			continue
		}

		credentials := turn.Generate(server.Secret, userID, now)
		out.TURN = append(out.TURN, config.TURNServer{
			URLs:       server.URLs,
			Username:   credentials.Username,
			Credential: credentials.Credential,
		})
	}

	return out
}

// iceOutput is the ICE configuration of the server. It is the configuration
// itself, so the contract is described in one place.
type iceOutput struct {
	Body config.ICEConfig
}
