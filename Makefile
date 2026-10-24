# RAMPCAST: one-command setup and run.
.PHONY: setup dev api app test build data

setup:            ## install Python and Node dependencies
	python3 -m venv server/.venv
	server/.venv/bin/pip install -q -r server/requirements.txt
	cd app && npm install --no-audit --no-fund

api:              ## run the API on :8000 (offline; no API keys needed)
	cd server && .venv/bin/uvicorn rampcast_server.main:app --reload --port 8000

app:              ## run the web app on :5173 (proxies /api to :8000)
	cd app && npx vite --port 5173

dev:              ## run both
	$(MAKE) -j2 api app

test:             ## server tests + app typecheck
	cd server && .venv/bin/pytest -q
	cd app && npx tsc -p tsconfig.json --noEmit

build:            ## production build of the app
	cd app && npx vite build

data:             ## build all processed data files for Role 1 (contracts/README.md)
	server/.venv/bin/python3 data/scripts/build_processed.py

fetch:            ## pull raw data from OpenSky + FAA registry (needs network + free OpenSky account)
	python3 data/scripts/fetch_opensky.py --preset analog
	python3 data/scripts/fetch_opensky.py --preset baseline
	python3 data/scripts/fetch_faa_registry.py
