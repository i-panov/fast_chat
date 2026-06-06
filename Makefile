BACKEND_PORT ?= 8080
SERVER_DOMAIN ?= localhost:$(BACKEND_PORT)
FRONTEND_PORT ?= 5173
API_PROXY ?= http://localhost:$(BACKEND_PORT)

backend\:run:
	cd backend && PORT=$(BACKEND_PORT) SERVER_DOMAIN=$(SERVER_DOMAIN) go run .

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

dev:
	@echo "Run in separate terminals:"
	@echo "  make backend:run"
	@echo "  make frontend:run"
	@echo ""
	@echo "Second instance (federation test):"
	@echo "  make backend:run BACKEND_PORT=8081 SERVER_DOMAIN=localhost:8081"
	@echo "  make frontend:run FRONTEND_PORT=5174 API_PROXY=http://localhost:8081"
