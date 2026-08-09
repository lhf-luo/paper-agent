#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_COMMAND="${PAPER_AGENT_NODE_BIN:-node}"
CLI_BIN_ROOT="${PAPER_AGENT_CLI_BIN:-${HOME:-}/.local/bin}"
TEAM_DEMO_ROOT="${PAPER_AGENT_TEAM_DEMO_ROOT:-${XDG_DATA_HOME:-${HOME:-}/.local/share}/paper-agent/team-demo}"

if [[ "${OS:-}" == "Windows_NT" || "${MSYSTEM:-}" == MINGW* || "${MSYSTEM:-}" == MSYS* ]]; then
	echo "On Windows, use .\\paper-agent.ps1 (or the installed paper-agent command) instead of run.sh." >&2
	exit 1
fi

if ! command -v "$NODE_COMMAND" >/dev/null 2>&1; then
	echo "Node.js was not found. Install Node.js 22.19 or newer." >&2
	exit 1
fi

NODE_VERSION="$($NODE_COMMAND -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 19) )); then
	echo "Paper Agent requires Node.js 22.19 or newer; found v$NODE_VERSION." >&2
	exit 1
fi

dependencies_available() {
	[[ -f "$AGENT_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" && -f "$AGENT_DIR/node_modules/vite/bin/vite.js" ]] || return 1
	local installed_lock="$AGENT_DIR/node_modules/.package-lock.json"
	[[ -f "$installed_lock" ]] || return 1
	"$NODE_COMMAND" -e 'const fs=require("node:fs"); const installed=fs.statSync(process.argv[1]).mtimeMs; for(const source of process.argv.slice(2)){if(fs.existsSync(source)&&fs.statSync(source).mtimeMs>installed+1000) process.exit(1)}' "$installed_lock" "$AGENT_DIR/package-lock.json"
}

require_dependencies() {
	if ! dependencies_available; then
		echo "Project dependencies are missing. Run npm ci and npm run web:build first." >&2
		exit 1
	fi
}

package_version() {
	"$NODE_COMMAND" -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(value.version));' "$AGENT_DIR/package.json"
}

setup_dependencies() {
	local npm_command="${PAPER_AGENT_NPM_BIN:-npm}"
	if ! command -v "$npm_command" >/dev/null 2>&1; then
		echo "npm was not found next to the selected Node.js installation." >&2
		exit 1
	fi
	cd "$AGENT_DIR"
	if [[ -f "$AGENT_DIR/package-lock.json" ]]; then
		"$npm_command" ci --ignore-scripts
	else
		echo "package-lock.json is absent from this distribution; installing pinned package.json ranges." >&2
		"$npm_command" install --ignore-scripts
	fi
	"$npm_command" run web:build
}

install_command() {
	if [[ -z "$CLI_BIN_ROOT" ]]; then
		echo "Cannot determine the user command directory. Set PAPER_AGENT_CLI_BIN and retry." >&2
		exit 1
	fi
	if [[ ! -f "$AGENT_DIR/dist/web/index.html" ]] || ! dependencies_available; then
		setup_dependencies
	fi
	mkdir -p "$CLI_BIN_ROOT"
	local shim="$CLI_BIN_ROOT/paper-agent"
	{
		echo '#!/usr/bin/env bash'
		printf 'exec %q "$@"\n' "$AGENT_DIR/run.sh"
	} > "$shim"
	chmod 0755 "$shim"
	echo "Installed command: $shim"
	case ":${PATH:-}:" in
		*:"$CLI_BIN_ROOT":*) ;;
		*)
			echo "Add this directory to PATH, then open a new terminal:" >&2
			printf '  export PATH=%q:$PATH\n' "$CLI_BIN_ROOT" >&2
			;;
	esac
	echo "Next: paper-agent --doctor"
}

uninstall_command() {
	local shim="$CLI_BIN_ROOT/paper-agent"
	if [[ -f "$shim" ]]; then
		if grep -Fq "$AGENT_DIR/run.sh" "$shim"; then
			rm -f -- "$shim"
			echo "Removed $shim. The source checkout and data were not deleted."
		else
			echo "Refusing to remove an unrelated command at $shim." >&2
			exit 1
		fi
	else
		echo "Paper Agent command is not installed at $shim."
	fi
}

start_web() {
	require_dependencies
	if [[ ! -f "$AGENT_DIR/dist/web/index.html" ]]; then
		(cd "$AGENT_DIR" && "$NODE_COMMAND" node_modules/vite/bin/vite.js build)
	fi
	exec "$NODE_COMMAND" "$AGENT_DIR/scripts/web-server.ts" "$@"
}

show_status() {
	require_dependencies
	exec "$NODE_COMMAND" "$AGENT_DIR/scripts/status.ts" "$@"
}

run_verification() {
	require_dependencies
	local mode="${1:-quick}"
	case "$mode" in
		quick|full|live) ;;
		*) echo "Unknown verification mode: $mode. Use quick, full, or live." >&2; exit 1 ;;
	esac
	exec "$NODE_COMMAND" "$AGENT_DIR/scripts/verify.ts" --mode "$mode"
}

start_agent() {
	require_dependencies
	for command in pdftotext pdftoppm pdfinfo pdfimages; do
		if ! command -v "$command" >/dev/null 2>&1; then
			echo "Missing $command. Install Poppler (brew install poppler or apt install poppler-utils)." >&2
			exit 1
		fi
	done
	local pdf=""
	local mode="quick"
	local extra=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--mode)
				mode="${2:-}"
				shift 2
				;;
			*.[pP][dD][fF])
				pdf="$1"
				shift
				;;
			*)
				extra+=("$1")
				shift
				;;
		esac
	done
	local args=("$AGENT_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" --no-approve --no-extensions --extension "$AGENT_DIR/src/index.ts" --skill "$AGENT_DIR/skills/literature-corpus-manager")
	if [[ -n "$pdf" ]]; then
		if [[ ! -f "$pdf" ]]; then echo "PDF not found: $pdf" >&2; exit 1; fi
		local absolute_pdf
		absolute_pdf="$(cd "$(dirname "$pdf")" && pwd)/$(basename "$pdf")"
		local prompt="/paper $mode \"$absolute_pdf\""
		if [[ ${#extra[@]} -gt 0 ]]; then prompt="$prompt ${extra[*]}"; fi
		args+=("$prompt")
		cd "$(dirname "$absolute_pdf")"
	fi
	exec "$NODE_COMMAND" "${args[@]}"
}

team_demo_state_field() {
	"$NODE_COMMAND" -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const field=value[process.argv[2]]; if(field===undefined) process.exit(2); process.stdout.write(String(field));' "$TEAM_DEMO_ROOT/state.json" "$1"
}

team_demo_process_matches() {
	local pid="$1"
	kill -0 "$pid" 2>/dev/null || return 1
	local command_line
	command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
	local normalized_command="${command_line//\\//}"
	local expected_path="${AGENT_DIR//\\//}/scripts/team-corpus-server.ts"
	if [[ "$normalized_command" == *"$expected_path"* ]]; then return 0; fi
	if command -v cygpath >/dev/null 2>&1; then
		local windows_path
		windows_path="$(cygpath -w "$AGENT_DIR/scripts/team-corpus-server.ts" 2>/dev/null || true)"
		windows_path="${windows_path//\\//}"
		[[ -n "$windows_path" && "$normalized_command" == *"$windows_path"* ]]
		return $?
	fi
	return 1
}

team_demo_health() {
	"$NODE_COMMAND" -e 'const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),2000); fetch(`http://127.0.0.1:${process.argv[1]}/health`,{signal:controller.signal}).then((response)=>{clearTimeout(timer); process.exit(response.ok?0:1)}).catch(()=>process.exit(1));' "$1" >/dev/null 2>&1
}

team_demo_pick_port() {
	"$NODE_COMMAND" -e 'const net=require("node:net"); const done=(server)=>{const address=server.address(); const port=typeof address==="object"&&address?address.port:0; server.close(()=>process.stdout.write(String(port)));}; const preferred=net.createServer(); preferred.once("error",()=>{const fallback=net.createServer(); fallback.listen(0,"127.0.0.1",()=>done(fallback));}); preferred.listen(4317,"127.0.0.1",()=>done(preferred));'
}

team_demo_status() {
	local state_file="$TEAM_DEMO_ROOT/state.json"
	if [[ ! -f "$state_file" ]]; then
		echo "Team demo is not initialized."
		return
	fi
	local pid port running=false healthy=false
	pid="$(team_demo_state_field pid 2>/dev/null || true)"
	port="$(team_demo_state_field port 2>/dev/null || true)"
	if [[ -n "$pid" ]] && team_demo_process_matches "$pid"; then running=true; fi
	if [[ -n "$port" ]] && team_demo_health "$port"; then healthy=true; fi
	echo "Team demo status"
	echo "Running: $running"
	echo "Healthy: $healthy"
	if [[ -n "$port" ]]; then echo "URL: http://127.0.0.1:$port"; fi
	echo "Data: $TEAM_DEMO_ROOT/corpus"
}

team_demo_stop() {
	local state_file="$TEAM_DEMO_ROOT/state.json"
	if [[ ! -f "$state_file" ]]; then
		echo "Team demo is not running."
		return
	fi
	local pid
	pid="$(team_demo_state_field pid 2>/dev/null || true)"
	if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
		if ! team_demo_process_matches "$pid"; then
			echo "Refusing to stop PID $pid because it is not the Paper Agent team demo server." >&2
			exit 1
		fi
		kill "$pid"
		for _ in {1..25}; do
			if ! kill -0 "$pid" 2>/dev/null; then break; fi
			sleep 0.2
		done
	fi
	rm -f -- "$state_file"
	echo "Team demo stopped. Demo data was kept at $TEAM_DEMO_ROOT"
}

team_demo_ensure_server() {
	if [[ -z "$TEAM_DEMO_ROOT" || "$TEAM_DEMO_ROOT" == "/" ]]; then
		echo "Cannot determine a safe team-demo data directory. Set PAPER_AGENT_TEAM_DEMO_ROOT." >&2
		exit 1
	fi
	local state_file="$TEAM_DEMO_ROOT/state.json"
	local auth_file="$TEAM_DEMO_ROOT/auth.json"
	local token_file="$TEAM_DEMO_ROOT/token.txt"
	local data_root="$TEAM_DEMO_ROOT/corpus"
	local backup_root="$TEAM_DEMO_ROOT/backups"
	local stdout_file="$TEAM_DEMO_ROOT/server.out.log"
	local stderr_file="$TEAM_DEMO_ROOT/server.err.log"
	local pid="" port=""
	if [[ -f "$state_file" ]]; then
		pid="$(team_demo_state_field pid 2>/dev/null || true)"
		port="$(team_demo_state_field port 2>/dev/null || true)"
		if [[ -n "$pid" && -n "$port" ]] && team_demo_process_matches "$pid" && team_demo_health "$port"; then
			return
		fi
	fi
	mkdir -p -- "$TEAM_DEMO_ROOT" "$data_root" "$backup_root"
	chmod 0700 "$TEAM_DEMO_ROOT" "$data_root" "$backup_root"
	"$NODE_COMMAND" -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const token=crypto.randomBytes(32).toString("base64url"); const hash=crypto.createHash("sha256").update(token).digest("hex"); fs.writeFileSync(process.argv[1],JSON.stringify({identities:[{name:"solo-demo-admin",tokenSha256:hash,roles:["admin"]}]},null,2)+"\n",{mode:0o600}); fs.writeFileSync(process.argv[2],token,{mode:0o600});' "$auth_file" "$token_file"
	chmod 0600 "$auth_file" "$token_file"
	port="$(team_demo_pick_port)"
	PAPER_AGENT_TEAM_AUTH_FILE="$auth_file" \
	PAPER_AGENT_TEAM_ROOT="$data_root" \
	PAPER_AGENT_TEAM_BACKUP_ROOT="$backup_root" \
	PAPER_AGENT_TEAM_HOST="127.0.0.1" \
	PAPER_AGENT_TEAM_PORT="$port" \
		nohup "$NODE_COMMAND" "$AGENT_DIR/scripts/team-corpus-server.ts" >"$stdout_file" 2>"$stderr_file" </dev/null &
	pid=$!
	local healthy=false
	for _ in {1..30}; do
		if team_demo_health "$port"; then healthy=true; break; fi
		if ! kill -0 "$pid" 2>/dev/null; then break; fi
		sleep 0.2
	done
	if [[ "$healthy" != true ]]; then
		if kill -0 "$pid" 2>/dev/null; then kill "$pid"; fi
		echo "Team demo server failed to start. See $stderr_file" >&2
		exit 1
	fi
	"$NODE_COMMAND" -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1],JSON.stringify({pid:Number(process.argv[2]),port:Number(process.argv[3]),startedAt:new Date().toISOString()},null,2)+"\n",{mode:0o600});' "$state_file" "$pid" "$port"
	chmod 0600 "$state_file"
}

team_demo_command() {
	local action="${1:-status}"
	shift || true
	case "$action" in
		status) team_demo_status ;;
		stop) team_demo_stop ;;
		demo)
			local use_agent=false no_open=false no_launch=false
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--agent) use_agent=true ;;
					--no-open) no_open=true ;;
					--no-launch) no_launch=true ;;
						*) echo "Unknown team demo option: $1. Use --agent, --no-open, or --no-launch." >&2; exit 1 ;;
				esac
				shift
			done
			if [[ "$use_agent" == true && "$no_open" == true ]]; then
				echo "--no-open applies only to the Web team demo." >&2
				exit 1
			fi
			team_demo_ensure_server
			local port
			port="$(team_demo_state_field port)"
			export PAPER_AGENT_TEAM_SERVER_URL="http://127.0.0.1:$port"
			export PAPER_AGENT_TEAM_TOKEN
			PAPER_AGENT_TEAM_TOKEN="$(<"$TEAM_DEMO_ROOT/token.txt")"
			export PAPER_AGENT_TEAM_NAMESPACE="solo-demo"
			export PAPER_AGENT_TEAM_DEMO="1"
			echo "Local team demo is ready. The service remains on this computer."
			echo "Run paper-agent --team stop when finished."
			if [[ "$no_launch" == true ]]; then return; fi
			if [[ "$use_agent" == true ]]; then
				start_agent
			else
				local web_args=(--port 0)
				if [[ "$no_open" == true ]]; then web_args+=(--no-open); fi
				start_web "${web_args[@]}"
			fi
			;;
		*) echo "Unknown team action: $action. Use demo, status, or stop." >&2; exit 1 ;;
	esac
}

case "${1:-}" in
	install|--install)
		install_command
		;;
	setup|--setup)
		setup_dependencies
		;;
	uninstall|--uninstall)
		uninstall_command
		;;
	init)
		shift
		require_dependencies
		exec "$NODE_COMMAND" "$AGENT_DIR/scripts/configure.ts" "$@"
		;;
	doctor|--doctor)
		shift
		require_dependencies
		exec "$NODE_COMMAND" "$AGENT_DIR/scripts/doctor.ts" "$@"
		;;
	status|--status)
		shift
		show_status "$@"
		;;
	verify|--verify)
		shift
		run_verification "${1:-quick}"
		;;
	agent|--agent)
		shift
		start_agent "$@"
		;;
	team|--team)
		shift
		team_demo_command "${1:-status}" "${@:2}"
		;;
	--mode)
		start_agent "$@"
		;;
	--version|-V|version)
		printf 'Paper Agent %s (%s)\n' "$(package_version)" "$AGENT_DIR"
		;;
	--help|-h|help)
		cat <<'USAGE'
Paper Agent
  ./run.sh install                  Install the user-level paper-agent command
  ./run.sh                          Open the local Web workspace
  ./run.sh paper.pdf                Open a PDF in the visual reader
  ./run.sh --no-open --port 4317    Run the local Web service
  ./run.sh init                     First-use configuration wizard
  ./run.sh doctor                   Environment diagnostics
  ./run.sh --status                 Show configured corpus and runtime status
  ./run.sh --verify quick|full|live Run a verification profile
  ./run.sh agent [paper.pdf]        Original Pi agent session
  ./run.sh --agent --mode full paper.pdf
  ./run.sh team demo                Open the loopback team demo in Web
  ./run.sh team demo --agent        Open the loopback team demo in Pi
  ./run.sh team status|stop         Inspect or stop the team demo service
  ./run.sh --version                Show the source version
  ./run.sh uninstall                Remove the user-level command
USAGE
		;;
	*.[pP][dD][fF])
		pdf="$1"
		shift
		if [[ ! -f "$pdf" ]]; then echo "PDF not found: $pdf" >&2; exit 1; fi
		absolute_pdf="$(cd "$(dirname "$pdf")" && pwd)/$(basename "$pdf")"
		start_web --pdf "$absolute_pdf" "$@"
		;;
	*)
		start_web "$@"
		;;
esac
