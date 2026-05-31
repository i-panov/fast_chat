backend\:run:
	cd backend && go run .

backend\:lint:
	cd backend && ~/go/bin/golangci-lint run ./...

frontend\:run:
	cd frontend && npx vite --host

frontend\:lint:
	cd frontend && npx eslint src/

lint:
	make backend:lint
	make frontend:lint

dev:
	@echo "Run in separate terminals:"
	@echo "  make backend:run"
	@echo "  make frontend:run"
	@echo ""
	@echo "Then open http://localhost:5173"
