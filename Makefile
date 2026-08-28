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

SEMGREP_RULES ?= $(HOME)/semgrep-rules
SEMGREP_FLAGS = --metrics=off --config .semgrep/rules
SEMGREP_SECRETS = --config $(SEMGREP_RULES)/generic/secrets

analyze: analyze\:backend analyze\:frontend

# Штатный анализ: курируемый набор (security + best-practice), почти без шума.
analyze\:backend:
	semgrep scan $(SEMGREP_FLAGS) $(SEMGREP_SECRETS) \
		--config $(SEMGREP_RULES)/go/lang/security \
		--config $(SEMGREP_RULES)/go/lang/best-practice \
		--config $(SEMGREP_RULES)/go/gorm \
		backend/

analyze\:frontend:
	semgrep scan $(SEMGREP_FLAGS) $(SEMGREP_SECRETS) \
		--config $(SEMGREP_RULES)/typescript/react/security \
		--config $(SEMGREP_RULES)/javascript/lang \
		--config $(SEMGREP_RULES)/javascript/browser \
		frontend/src/

# Глубокий анализ: полные пакеты правил (шумнее, но покрывает всё).
analyze\:deep: analyze\:deep\:backend analyze\:deep\:frontend

analyze\:deep\:backend:
	semgrep scan $(SEMGREP_FLAGS) $(SEMGREP_SECRETS) \
		--config $(SEMGREP_RULES)/go \
		backend/

analyze\:deep\:frontend:
	semgrep scan $(SEMGREP_FLAGS) $(SEMGREP_SECRETS) \
		--config $(SEMGREP_RULES)/javascript \
		--config $(SEMGREP_RULES)/typescript \
		frontend/src/

# Глубокий анализ CodeQL (periodic): создаёт базы в .codeql/, SARIF в .codeql/sarif/.
codeql: codeql\:backend codeql\:frontend

codeql\:backend:
	scripts/codeql-go.sh

codeql\:frontend:
	scripts/codeql-js.sh

lint:
	make backend:lint
	make frontend:lint

build\:frontend:
	cd frontend && npm ci && npm run build

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)

build\:backend:
	cd backend && mkdir -p bin && CGO_ENABLED=0 go build \
		-trimpath \
		-ldflags="-s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X fast_chat/handler.version=$(VERSION) -X fast_chat/handler.commit=$(COMMIT)" \
		-o bin/fastchat .

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
