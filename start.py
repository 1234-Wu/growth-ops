#!/usr/bin/env python3
"""Growth Ops 一键启动脚本（支持热加载 / Dev 模式 与 生产模式）.

默认启动热加载模式：
    - Python 后端服务 (127.0.0.1:8787)
    - Next.js 前端热更新服务 (127.0.0.1:3000)
    - 自动复制 API Key 到剪贴板并在浏览器打开工作台

双击 start.command 或在终端运行：
    python3 start.py          # 启动热加载开发模式
    python3 start.py --prod   # 启动轻量静态生产模式
"""

from __future__ import annotations

import argparse
import atexit
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
os.chdir(ROOT_DIR)
sys.path.insert(0, str(ROOT_DIR))

import server

PYTHON_PORT = 8787
DEV_PORT = 3000
HOST = "127.0.0.1"


def check_url(url: str, timeout: float = 1.0) -> bool:
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status in (200, 304)
    except Exception:
        return False


def copy_to_clipboard(text: str) -> bool:
    if sys.platform == "darwin":
        try:
            subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=False)
            return True
        except Exception:
            pass
    return False


def wait_for_ready(url: str, max_wait: float = 25.0, step: float = 0.3) -> bool:
    start = time.time()
    while time.time() - start < max_wait:
        if check_url(url):
            return True
        time.sleep(step)
    return False


def run_prod(host: str, port: int, api_key: str) -> int:
    if check_url(f"http://{host}:{port}/health"):
        url = f"http://{host}:{port}/?key={api_key}"
        copied = copy_to_clipboard(api_key)
        try:
            webbrowser.open(url)
        except Exception:
            pass
        print("=" * 60)
        print("  🎉 Growth Ops 静态服务已在后台运行！")
        print(f"  🌐 工作台地址: http://{host}:{port}")
        print(f"  🔑 访问密钥:   {api_key}" + (" (已自动复制到剪贴板)" if copied else ""))
        print("  🚀 已在浏览器中打开并自动登录。")
        print("=" * 60)
        if sys.stdin.isatty():
            try:
                input("\n按回车键退出当前窗口...")
            except (KeyboardInterrupt, EOFError):
                pass
        return 0

    copied = copy_to_clipboard(api_key)
    print("=" * 60)
    print("  🚀 正在启动 Growth Ops 静态生产版...")
    print(f"  🌐 工作台地址: http://{host}:{port}")
    print(f"  🔑 访问密钥:   {api_key}" + (" (已自动复制到剪贴板)" if copied else ""))
    print("  🖥️  正在打开默认浏览器并自动登录...")
    print("  💡 提示: 按 Ctrl+C 可安全停止服务")
    print("=" * 60)
    try:
        return server.main(["--host", host, "--port", str(port), "--open"])
    except KeyboardInterrupt:
        print("\n👋 服务已停止。")
        return 0


def kill_port(port: int) -> None:
    try:
        out = subprocess.check_output(["lsof", "-ti", f":{port}"], text=True).strip()
        for pid_str in out.splitlines():
            pid = int(pid_str)
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGTERM)
                except Exception:
                    pass
    except Exception:
        pass


def run_dev(host: str, api_key: str) -> int:
    # 检查 npm / node
    if not shutil.which("npm") or not shutil.which("node"):
        print("⚠️ 未检测到 Node.js / npm 环境，正在回退至静态模式运行...", file=sys.stderr)
        return run_prod(host, PYTHON_PORT, api_key)

    # 清理可能存在的历史残留进程，确保前后端均加载当前最新代码
    kill_port(PYTHON_PORT)
    kill_port(DEV_PORT)
    time.sleep(0.4)

    copied = copy_to_clipboard(api_key)
    print("=" * 62)
    print("  🔥 正在一键启动 Growth Ops【热加载开发版】...")
    print(f"  🌐 前端热更新地址: http://{host}:{DEV_PORT}")
    print(f"  ⚙️  后端 API 端口:   http://{host}:{PYTHON_PORT}")
    print(f"  🔑 访问密钥:         {api_key}" + (" (已自动复制到剪贴板)" if copied else ""))
    print("  ✨ 修改前端 React / CSS 将实时热重载（Fast Refresh）！")
    print("  💡 提示: 按 Ctrl+C 可同时停止前后端所有服务")
    print("=" * 62)

    procs: list[subprocess.Popen] = []

    def cleanup() -> None:
        for p in procs:
            if p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass
        for p in procs:
            try:
                p.wait(timeout=2.0)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    atexit.register(cleanup)

    def handle_signal(sig, frame):
        cleanup()
        print("\n👋 前后端服务已全部停止。")
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    # 1. 启动 Python 后端（如果尚未运行）
    env = os.environ.copy()
    env["GROWTH_HOST"] = host
    env["GROWTH_PORT"] = str(PYTHON_PORT)
    env["GROWTH_DEV_PROXY"] = str(DEV_PORT)
    env["GROWTH_ALLOWED_ORIGINS"] = f"http://{host}:{DEV_PORT},http://localhost:{DEV_PORT}"

    if not check_url(f"http://{host}:{PYTHON_PORT}/health"):
        backend_proc = subprocess.Popen(
            [sys.executable, str(ROOT_DIR / "server.py")],
            env=env,
            cwd=str(ROOT_DIR),
        )
        procs.append(backend_proc)

        if not wait_for_ready(f"http://{host}:{PYTHON_PORT}/health", max_wait=6.0):
            print("❌ 后端服务启动超时，请检查控制台输出。", file=sys.stderr)
            cleanup()
            return 1
        print("  ✅ 后端 API 服务已就绪 (127.0.0.1:8787)。")
    else:
        print("  ℹ️ 后端 API 服务已在运行 (127.0.0.1:8787)。")

    # 2. 启动 Next.js Dev 前端（如果尚未运行）
    frontend_proc = None
    if not check_url(f"http://{host}:{DEV_PORT}"):
        frontend_proc = subprocess.Popen(
            ["npm", "--prefix", "web", "run", "dev"],
            cwd=str(ROOT_DIR),
        )
        procs.append(frontend_proc)
        print("  ⏳ 正在启动 Next.js 热加载服务，等待就绪...")
    else:
        print(f"  ℹ️ Next.js 热加载服务已在运行 (127.0.0.1:{DEV_PORT})。")

    # 3. 后端 Python 文件变动自动热重载监听（改代码自动生效，免手动重启）
    def _py_watcher() -> None:
        def get_mtimes() -> dict[str, float]:
            mtimes: dict[str, float] = {}
            for root, dirs, files in os.walk(ROOT_DIR):
                dirs[:] = [d for d in dirs if d not in (".git", "node_modules", ".next", ".next-dev", "__pycache__", "data")]
                for f in files:
                    if f.endswith(".py") and not f.startswith("."):
                        fp = os.path.join(root, f)
                        try:
                            mtimes[fp] = os.path.getmtime(fp)
                        except OSError:
                            pass
            return mtimes

        last_mtimes = get_mtimes()
        while True:
            time.sleep(1.0)
            current_mtimes = get_mtimes()
            changed_file = ""
            for fp, mtime in current_mtimes.items():
                if fp not in last_mtimes or mtime > last_mtimes.get(fp, 0):
                    changed_file = os.path.basename(fp)
                    break
            if not changed_file and len(current_mtimes) != len(last_mtimes):
                changed_file = "文件变动"

            if changed_file:
                last_mtimes = current_mtimes
                print(f"\n🔄 检测到 Python 文件变动 ({changed_file})，正在自动热重载后端服务...", flush=True)
                for i, p in enumerate(procs):
                    if p != frontend_proc and p.poll() is None:
                        try:
                            p.terminate()
                            p.wait(timeout=2.0)
                        except Exception:
                            try:
                                p.kill()
                            except Exception:
                                pass
                        new_backend = subprocess.Popen(
                            [sys.executable, str(ROOT_DIR / "server.py")],
                            env=env,
                            cwd=str(ROOT_DIR),
                        )
                        procs[i] = new_backend
                        print("  ✅ 后端服务已自动热重载生效！\n", flush=True)
                        break

    import threading
    threading.Thread(target=_py_watcher, daemon=True).start()

    # 4. 等待前端可用后打开浏览器并自动登录
    def _open_when_ready() -> None:
        target_url = f"http://{host}:{DEV_PORT}/?key={api_key}"
        if wait_for_ready(f"http://{host}:{DEV_PORT}", max_wait=30.0):
            print(f"\n  🚀 热加载工作台已就绪，正在打开浏览器: http://{host}:{DEV_PORT} ...")
            try:
                webbrowser.open(target_url)
            except Exception:
                pass
        else:
            print(f"\n  ⚠️ 等待就绪超时，您可直接访问: {target_url}")

    threading.Thread(target=_open_when_ready, daemon=True).start()

    # 4. 保持运行，监控子进程
    try:
        while True:
            for p in procs:
                ret = p.poll()
                if ret is not None and ret != 0:
                    print(f"\n⚠️ 服务子进程退出 (code: {ret})")
                    cleanup()
                    return ret
            time.sleep(0.5)
    except KeyboardInterrupt:
        cleanup()
        print("\n👋 服务已停止。")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Growth Ops 一键启动脚本")
    parser.add_argument("--prod", action="store_true", help="启动静态生产模式（单 Python 服务）")
    parser.add_argument("--host", default=os.environ.get("GROWTH_HOST", HOST))
    args, _ = parser.parse_known_args()

    api_key = server.ensure_api_key()

    if args.prod:
        port = int(os.environ.get("GROWTH_PORT", str(PYTHON_PORT)))
        return run_prod(args.host, port, api_key)
    else:
        return run_dev(args.host, api_key)


if __name__ == "__main__":
    raise SystemExit(main())
