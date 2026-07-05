BACKEND_PORT ?= 8080
SERVER_DOMAIN ?= localhost:$(BACKEND_PORT)
FRONTEND_PORT ?= 5173
API_PROXY ?= http://localhost:$(BACKEND_PORT)

backend\:run:
	cd backend && go run . --config=../config/dev.yaml

backend\:lint:
	cd backend && ~/go/bin/golangci-lint run ./...

backend\:test:
	cd backend && go test -race -count=1 ./...

frontend\:run:
	cd frontend && VITE_API_PROXY=$(API_PROXY) npx vite --host --port $(FRONTEND_PORT)

frontend\:lint:
	cd frontend && npx biome check src/

frontend\:lint\:fix:
	cd frontend && npx biome check --write src/

frontend\:format:
	cd frontend && npx biome format --write src/

lint:
	make backend:lint
	make frontend:lint

build\:frontend:
	cd frontend && npm run build

build\:backend:
	cd backend && mkdir -p bin && CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/fastchat .

build: build\:frontend build\:backend
	@echo ""
	@echo "Built: backend/bin/fastchat (single binary, no CGO)"
	@echo "Run: cd backend && ./bin/fastchat --config=../config/prod.yaml"

dev:
	@echo "Run in separate terminals:"
	@echo "  make backend:run"
	@echo "  make frontend:run"
	@echo ""
	@echo "Second instance (federation test):"
	@echo "  make backend:run BACKEND_PORT=8081 SERVER_DOMAIN=localhost:8081"
	@echo "  make frontend:run FRONTEND_PORT=5174 API_PROXY=http://localhost:8081"
