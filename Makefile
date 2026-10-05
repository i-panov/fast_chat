BACKEND_PORT ?= 8080
SERVER_DOMAIN ?= localhost:$(BACKEND_PORT)
FRONTEND_PORT ?= 5173
API_PROXY ?= http://localhost:$(BACKEND_PORT)

# golangci-lint собирается из исходников тем же тулчейном, что и бэкенд.
# Готовый бинарник, собранный более старым Go, не парсит stdlib новой версии
# и падает с "file requires newer Go version" — поэтому ставим через go install.
GOLANGCI_LINT_VERSION ?= v2.14.0
GOLANGCI_LINT := $(shell go env GOPATH)/bin/golangci-lint

backend\:run:
	cd backend && go run . --config=../config/dev.yaml

backend\:lint:
	@if [ ! -x "$(GOLANGCI_LINT)" ]; then \
		echo "golangci-lint not found at $(GOLANGCI_LINT)"; \
		echo "Install it with: make backend:lint:install"; \
		exit 1; \
	fi
	cd backend && $(GOLANGCI_LINT) run ./...

# Обновление линтера: поднять GOLANGCI_LINT_VERSION и выполнить эту цель.
# Перепроверять после каждого обновления тулчейна Go.
backend\:lint\:install:
	go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)

# Таймзона для тестов. Хранимые timestamps сравниваются как текст с курсором
# синка в UTC, поэтому дефект ловится только вне UTC: на TZ=UTC набор проходит
# тривиально. Имя TEST_TZ, а не TZ, потому что make импортирует переменные
# окружения как make-переменные — `TZ ?=` молча перекрылся бы экспортом TZ=UTC.
# Зона по умолчанию — западнее UTC. Переопределение: make backend:test TEST_TZ=Asia/Tokyo
TEST_TZ ?= America/New_York

backend\:test:
	cd backend && TZ=$(TEST_TZ) go test -race -count=1 ./...

frontend\:test:
	cd frontend && npx vitest run

frontend\:run:
	cd frontend && VITE_API_PROXY=$(API_PROXY) npx vite --host --port $(FRONTEND_PORT)

frontend\:lint:
	cd frontend && npx biome check src/ && npx eslint .

frontend\:lint\:fix:
	cd frontend && npx biome check --write src/ && npx eslint . --fix

frontend\:lint\:deadcode:
	cd frontend && npx knip

frontend\:size:
	cd frontend && npx size-limit

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

dead-code:
	make frontend:lint:deadcode

test:
	make backend:test
	make frontend:test

coverage: coverage\:backend coverage\:frontend

coverage\:backend:
	mkdir -p coverage
	cd backend && go test -coverpkg=./... -coverprofile=../coverage/backend.out ./...
	cd backend && go tool cover -func=../coverage/backend.out
	cd backend && go tool cover -html=../coverage/backend.out -o ../coverage/backend.html

coverage\:frontend:
	cd frontend && npx vitest run --coverage

build\:frontend:
	cd frontend && npm ci && npm run build

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)

build\:backend:
	cd backend && mkdir -p bin && CGO_ENABLED=0 go build \
		-trimpath \
		-ldflags="-s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)" \
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
