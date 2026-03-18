.PHONY: lint format check test

lint:
	ruff check .

format:
	ruff format .
	ruff check --fix .

check:
	ruff check .
	ruff format --check .

test:
	uv run pytest tests/ -v
