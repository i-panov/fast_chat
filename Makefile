backend\:run:
	cd backend && go run .

backend\:run\:8081:
	cd backend && PORT=8081 SERVER_DOMAIN=localhost:8081 go run .

backend\:lint:
	cd backend && ~/go/bin/golangci-lint run ./...

frontend\:run:
	cd frontend && npx vite --host

frontend\:run\:8081:
	cd frontend && VITE_API_PROXY=http://localhost:8081 npx vite --host --port 5174

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
	@echo "For federation testing (second instance):"
	@echo "  make backend:run:8081"
	@echo "  make frontend:run:8081"
	@echo ""
	@echo "Then open http://localhost:5173 and http://localhost:5174"
