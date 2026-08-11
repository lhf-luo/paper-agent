#!/usr/bin/env bash
# 团队库 Docker 服务管理脚本
# 用法: ./team-server.sh {start|stop|restart|status|logs|rebuild}
# 说明:
#   - start   启动服务(镜像不存在会自动构建); 数据在 docker 命名卷中
#   - stop    停止服务(数据保留)
#   - restart 重启服务
#   - rebuild 重新构建镜像并启动(修改了 Dockerfile/src 后使用)
#   - status  查看容器与健康状态
#   - logs    跟踪服务日志
# 注意: 不要使用 docker-compose down -v 作为常规停止方式, 它会删除数据卷!
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
AUTH_FILE="$SCRIPT_DIR/auth.json"
HEALTH_URL="http://127.0.0.1:4317/health"

# 优先用独立 docker-compose 命令, 否则尝试 docker compose 插件
if command -v docker-compose >/dev/null 2>&1; then
	COMPOSE=(docker-compose -f "$COMPOSE_FILE")
else
	COMPOSE=(docker compose -f "$COMPOSE_FILE")
fi

require_auth() {
	if [[ ! -f "$AUTH_FILE" ]]; then
		echo "错误: 缺少 $AUTH_FILE" >&2
		echo "请先复制 auth.example.json 为 auth.json, 填入成员 tokenSha256 后重试。" >&2
		exit 1
	fi
	# 容器内以 node 用户(UID 1000)运行, auth.json 必须对他人可读。
	# 该文件只含 token 哈希(无明文), 本地开发场景可接受。
	if [[ "$(stat -c %a "$AUTH_FILE")" =~ ^[0-7][0-7]0$ ]] || [[ "$(stat -c %a "$AUTH_FILE")" =~ ^[0-7]0[0-7]$ ]]; then
		chmod 644 "$AUTH_FILE"
		echo "提示: auth.json 权限已调整为 644(容器内 node 用户需可读)。"
	fi
}

case "${1:-}" in
	start)
		require_auth
		"${COMPOSE[@]}" up -d
		echo "已启动。服务地址: http://127.0.0.1:4317"
		;;
	stop)
		"${COMPOSE[@]}" stop
		echo "已停止(数据保留, 下次 start 即可恢复)。"
		;;
	restart)
		"${COMPOSE[@]}" restart
		echo "已重启。"
		;;
	rebuild)
		require_auth
		"${COMPOSE[@]}" up -d --build
		echo "已重新构建并启动。"
		;;
	status)
		"${COMPOSE[@]}" ps
		if curl -s -o /dev/null --max-time 3 "$HEALTH_URL"; then
			echo "健康检查: OK (HTTP 200)"
		else
			echo "健康检查: 不可达(服务可能未启动)"
		fi
		;;
	logs)
		"${COMPOSE[@]}" logs -f team-corpus
		;;
	*)
		echo "用法: $0 {start|stop|restart|status|logs|rebuild}"
		echo "示例: ./team-server.sh start"
		exit 1
		;;
esac
