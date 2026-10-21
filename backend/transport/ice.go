package transport

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/config"
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
	}, func(_ context.Context, _ *struct{}) (*iceOutput, error) {
		return &iceOutput{Body: cfg.ICE}, nil
	})
}

// iceOutput is the ICE configuration of the server. It is the configuration
// itself, so the contract is described in one place.
type iceOutput struct {
	Body config.ICEConfig
}
