#!/usr/bin/env bash
set -euo pipefail

# setup.sh
# Usage: ./setup.sh [project_dir]
# Environment overrides: PROJECT_DIR, SERVICE_NAME, PORT

PROJECT_DIR="${1:-${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}}"
SERVICE_NAME="${SERVICE_NAME:-athan}"
PORT="${PORT:-3000}"

# Use sudo when not running as root
SUDO_CMD=""
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
	SUDO_CMD="sudo"
fi

# Determine run user (honor SUDO_USER when invoked with sudo)
RUN_USER="${SUDO_USER:-${RUN_USER:-$(id -un)}}"
RUN_HOME="$(eval echo "~${RUN_USER}")"

echo "Project directory: ${PROJECT_DIR}"
echo "Service name: ${SERVICE_NAME}"
echo "Port: ${PORT}"
echo "Run user: ${RUN_USER}"

# Detect tools
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
CLOUDFLARED_BIN="$(command -v cloudflared || true)"

# Install npm deps (if npm available)
if [ -n "${NPM_BIN}" ]; then
	echo "Installing npm packages (production)..."
	(cd "${PROJECT_DIR}" && "${NPM_BIN}" install --omit=dev)
else
	echo "npm not found in PATH; please install Node.js and npm if needed. Skipping npm install."
fi

# Detect systemd availability
SYSTEMD_AVAILABLE=false
if command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1; then
	SYSTEMD_AVAILABLE=true
fi

create_node_service_systemd() {
	echo "Creating systemd service for ${SERVICE_NAME} (user=${RUN_USER})..."
	PATH_ENV="${PATH:-/usr/bin:/usr/local/bin}"
	if [ -n "${NODE_BIN}" ]; then
		NODE_DIR="$(dirname "${NODE_BIN}")"
		case ":${PATH_ENV}:" in
			*":${NODE_DIR}:"*) ;;
			*) PATH_ENV="${PATH_ENV}:${NODE_DIR}" ;;
		esac
	fi

	${SUDO_CMD} tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=${SERVICE_NAME} Node app
After=network.target

[Service]
User=${RUN_USER}
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=PATH=${PATH_ENV}
ExecStart=/usr/bin/env node server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

	${SUDO_CMD} systemctl daemon-reload
	${SUDO_CMD} systemctl enable --now ${SERVICE_NAME}
	echo "Node service status:"
	${SUDO_CMD} systemctl status ${SERVICE_NAME} --no-pager || true
}

install_pm2_and_start() {
	if [ -n "${NPM_BIN}" ]; then
		echo "Installing pm2 and starting app..."
		${SUDO_CMD} ${NPM_BIN} install -g pm2
		pm2 start server/index.js --name "${SERVICE_NAME}" --cwd "${PROJECT_DIR}" || true
		pm2 save || true
		echo "pm2 started ${SERVICE_NAME}. Ensure pm2 startup is configured for your system."
	else
		echo "npm not found; cannot install pm2. Start the app manually." 
	fi
}

if [ "${SYSTEMD_AVAILABLE}" = true ]; then
	create_node_service_systemd
else
	echo "systemd not detected; falling back to pm2 or manual start."
	install_pm2_and_start
fi

install_cloudflared() {
	if [ -n "${CLOUDFLARED_BIN}" ] && [ -x "${CLOUDFLARED_BIN}" ]; then
		echo "cloudflared already installed at ${CLOUDFLARED_BIN}" && return 0
	fi

	OS_NAME="$(uname -s)"
	ARCH="$(uname -m)"
	if [ "${OS_NAME}" = "Darwin" ]; then
		if command -v brew >/dev/null 2>&1; then
			echo "Installing cloudflared via Homebrew..."
			${SUDO_CMD} brew install cloudflared || return 1
			CLOUDFLARED_BIN="$(command -v cloudflared || true)"
			return 0
		else
			echo "Homebrew not found - please install cloudflared manually on macOS." && return 1
		fi
	elif [ "${OS_NAME}" = "Linux" ]; then
		case "${ARCH}" in
			x86_64|amd64) BIN=cloudflared-linux-amd64;;
			aarch64|arm64) BIN=cloudflared-linux-arm64;;
			armv7l|armv6l|arm) BIN=cloudflared-linux-arm;;
			*) BIN=cloudflared-linux-amd64;;
		esac
		URL="https://github.com/cloudflare/cloudflared/releases/latest/download/${BIN}"
		TMPFILE="/tmp/cloudflared.$$"
		echo "Downloading cloudflared from ${URL}..."
		curl -fsSL -o "${TMPFILE}" "${URL}" || { echo "Download failed"; rm -f "${TMPFILE}"; return 1; }
		${SUDO_CMD} mv "${TMPFILE}" /usr/local/bin/cloudflared
		${SUDO_CMD} chmod +x /usr/local/bin/cloudflared
		CLOUDFLARED_BIN="/usr/local/bin/cloudflared"
		echo "Installed cloudflared to ${CLOUDFLARED_BIN}"
		return 0
	else
		echo "Unsupported OS: ${OS_NAME}. Please install cloudflared manually." && return 1
	fi
}

# Install cloudflared if missing
if [ -z "${CLOUDFLARED_BIN}" ]; then
	echo "cloudflared not found; attempting to install..."
	if ! install_cloudflared; then
		echo "cloudflared installation failed or manual intervention required. Skipping cloudflared service creation."
	else
		CLOUDFLARED_BIN="$(command -v cloudflared || true)"
	fi
fi

CLOUDFLARED_SERVICE="${CLOUDFLARED_SERVICE:-cloudflared-ephemeral}"

create_cloudflared_systemd() {
	if [ -z "${CLOUDFLARED_BIN}" ]; then
		echo "cloudflared binary not available; cannot create systemd service." && return 1
	fi
	echo "Creating systemd service for cloudflared ephemeral tunnel..."
	${SUDO_CMD} tee /etc/systemd/system/${CLOUDFLARED_SERVICE}.service > /dev/null <<EOF
[Unit]
Description=cloudflared ephemeral trycloudflare tunnel
After=${SERVICE_NAME}.service network-online.target
Wants=${SERVICE_NAME}.service

[Service]
User=${RUN_USER}
Environment=PATH=${PATH}
ExecStart=${CLOUDFLARED_BIN} tunnel --url http://localhost:${PORT}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

	${SUDO_CMD} systemctl daemon-reload
	${SUDO_CMD} systemctl enable --now ${CLOUDFLARED_SERVICE}
	echo "cloudflared service status:"
	${SUDO_CMD} systemctl status ${CLOUDFLARED_SERVICE} --no-pager || true

	# try to extract ephemeral URL from logs
	sleep 2
	TRY_URL="$(${SUDO_CMD} journalctl -u ${CLOUDFLARED_SERVICE} -n 200 --no-pager | grep -oE 'https://[A-Za-z0-9.-]+trycloudflare.com' | tail -n1 || true)"
	if [ -n "${TRY_URL}" ]; then
		echo "Ephemeral URL: ${TRY_URL}"
		echo "${TRY_URL}" > "${RUN_HOME}/trycloudflare_url.txt"
		${SUDO_CMD} chown "${RUN_USER}:" "${RUN_HOME}/trycloudflare_url.txt" || true
		echo "Saved to ${RUN_HOME}/trycloudflare_url.txt"
	else
		echo "Could not find trycloudflare URL in logs. Run: sudo journalctl -u ${CLOUDFLARED_SERVICE} -f"
	fi
}

create_cloudflared_cron() {
	if [ -z "${CLOUDFLARED_BIN}" ]; then
		echo "cloudflared binary not available; cannot create cron entry." && return 1
	fi
	echo "Creating @reboot cron entry for ${RUN_USER} to start cloudflared..."
	CRON_CMD="@reboot ${CLOUDFLARED_BIN} tunnel --url http://localhost:${PORT} > ${RUN_HOME}/cloudflared.log 2>&1 &"
	if [ "${EUID:-$(id -u)}" -eq 0 ]; then
		${SUDO_CMD} crontab -u "${RUN_USER}" -l 2>/dev/null | { cat; echo "${CRON_CMD}"; } | ${SUDO_CMD} crontab -u "${RUN_USER}" -
	else
		(crontab -l 2>/dev/null || true; echo "${CRON_CMD}") | crontab -
	fi
	echo "Starting cloudflared now (background)..."
	nohup ${CLOUDFLARED_BIN} tunnel --url "http://localhost:${PORT}" > "${RUN_HOME}/cloudflared.log" 2>&1 &
	sleep 3
	TRY_URL="$(grep -oE 'https://[A-Za-z0-9.-]+trycloudflare.com' "${RUN_HOME}/cloudflared.log" | tail -n1 || true)"
	if [ -n "${TRY_URL}" ]; then
		echo "Ephemeral URL: ${TRY_URL}"
		echo "${TRY_URL}" > "${RUN_HOME}/trycloudflare_url.txt"
	else
		echo "Could not find trycloudflare URL in ${RUN_HOME}/cloudflared.log. Tail the log to see output: tail -f ${RUN_HOME}/cloudflared.log"
	fi
}

if [ "${SYSTEMD_AVAILABLE}" = true ]; then
	create_cloudflared_systemd || echo "Failed to create cloudflared systemd service. Check logs."
else
	create_cloudflared_cron || echo "Failed to create cron-based startup for cloudflared. Check permissions."
fi

echo "Setup complete. If services failed, inspect logs:"
echo "  sudo journalctl -u ${SERVICE_NAME} -n 200 --no-pager"
echo "  sudo journalctl -u ${CLOUDFLARED_SERVICE} -n 200 --no-pager"
