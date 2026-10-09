"""Zero-configuration automatic background sync worker for OneNexa desktop nodes.

Runs completely silently and automatically in the background without requiring
any manual setup, IP entry, configuration, or user interaction:
1. Admin PC silently broadcasts its presence on the office LAN.
2. Staff PCs automatically discover the Admin PC (via UDP beacon and LAN probe).
3. Every local save triggers an immediate, silent background merge with Admin PC and Platform Owner.
4. When network/internet starts, all pending offline records are automatically merged (Last-Write-Wins).
5. Consolidated office records are automatically synchronized with the Platform Owner cloud.
6. Zero user interaction, zero signs, zero banners, zero toasts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
from typing import Any

import httpx

from backend import local_first_store as store
from backend import local_first_sync as sync

logger = logging.getLogger("local_first_worker")

DISCOVERY_UDP_PORT = 7439
_worker_task: asyncio.Task | None = None
_beacon_task: asyncio.Task | None = None
_listener_task: asyncio.Task | None = None
_scanner_task: asyncio.Task | None = None
_sync_in_progress = False
_sync_trigger_event: asyncio.Event | None = None
_discovered_hub_url: str | None = None


def get_active_sync_targets() -> list[str]:
    """Return all valid sync targets (Admin PC on LAN and/or Platform Owner Cloud)."""
    global _discovered_hub_url
    targets: list[str] = []
    my_ips = sync.get_local_ip_addresses()
    server_port = int(os.getenv("PORT", "7432"))
    self_urls = {
        f"http://127.0.0.1:{server_port}",
        f"http://localhost:{server_port}",
        *[f"http://{ip}:{server_port}" for ip in my_ips],
    }

    # 1. LAN Admin Hub (from discovery or saved cursor)
    if not _discovered_hub_url:
        try:
            remembered = store.get_sync_cursor("discovered_hub_url")
            if remembered and str(remembered).strip():
                _discovered_hub_url = str(remembered).strip()
        except Exception:
            pass

    if _discovered_hub_url and _discovered_hub_url not in self_urls:
        targets.append(_discovered_hub_url)

    # 2. Explicit LAN sync target
    explicit_target = os.getenv("ONENEXA_SYNC_TARGET", "").strip()
    if explicit_target and explicit_target not in self_urls and explicit_target not in targets:
        targets.append(explicit_target)

    # 3. Platform Owner Cloud target
    cloud_target = (
        os.getenv("ONENEXA_CLOUD_TARGET", "").strip()
        or os.getenv("ONENEXA_PLATFORM_OWNER_URL", "").strip()
    )
    if cloud_target and cloud_target not in self_urls and cloud_target not in targets:
        targets.append(cloud_target)

    return targets


def get_active_sync_target() -> str:
    """Convenience getter returning primary sync target."""
    targets = get_active_sync_targets()
    return targets[0] if targets else ""


def trigger_immediate_background_sync() -> None:
    """Wake up the sync loop immediately when any local record is saved or network reconnects."""
    global _sync_trigger_event
    if _sync_trigger_event is not None:
        _sync_trigger_event.set()


async def _lan_beacon_sender(port: int = 7439) -> None:
    """Admin Hub loop: broadcasts presence across office LAN every 8 seconds."""
    while True:
        try:
            role = os.getenv("ONENEXA_NODE_ROLE", "admin").lower()
            has_outbound_target = bool(os.getenv("ONENEXA_SYNC_TARGET", "").strip())
            if role == "admin" or not has_outbound_target:
                my_ips = sync.get_local_ip_addresses()
                primary_ip = my_ips[0] if my_ips else "127.0.0.1"
                server_port = int(os.getenv("PORT", "7432"))
                beacon_data = json.dumps({
                    "onenexa": "hub_beacon",
                    "url": f"http://{primary_ip}:{server_port}",
                    "device_id": store.get_device_id(),
                    "company_id": os.getenv("ONENEXA_DEFAULT_COMPANY_ID", "company-master"),
                    "role": "admin",
                }).encode("utf-8")

                try:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    sock.setblocking(False)
                    # Broadcast to global subnet
                    sock.sendto(beacon_data, ("255.255.255.255", port))
                    # Also broadcast to interface-specific subnets
                    for ip in my_ips:
                        if "." in ip and not ip.startswith("127."):
                            parts = ip.split(".")
                            bcast = f"{parts[0]}.{parts[1]}.{parts[2]}.255"
                            try:
                                sock.sendto(beacon_data, (bcast, port))
                            except Exception:
                                pass
                    sock.close()
                except Exception as exc:
                    logger.debug("LAN beacon broadcast: %s", exc)

            await asyncio.sleep(8)
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(8)


async def _lan_beacon_listener(port: int = 7439) -> None:
    """Staff workstation loop: listens for Admin Hub UDP beacon on office LAN."""
    global _discovered_hub_url
    loop = asyncio.get_running_loop()

    while True:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("", port))
            except Exception:
                sock.close()
                await asyncio.sleep(15)
                continue

            sock.setblocking(False)

            while True:
                try:
                    data, addr = await loop.sock_recvfrom(sock, 2048)
                    payload = json.loads(data.decode("utf-8", errors="ignore"))
                    if payload.get("onenexa") == "hub_beacon" and payload.get("url"):
                        hub_url = payload["url"]
                        my_device = store.get_device_id()
                        if payload.get("device_id") != my_device:
                            if _discovered_hub_url != hub_url:
                                logger.info("Auto-discovered OneNexa Office Admin Hub at %s", hub_url)
                                _discovered_hub_url = hub_url
                                store.save_sync_cursor("discovered_hub_url", hub_url)
                                trigger_immediate_background_sync()
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
                except asyncio.CancelledError:
                    sock.close()
                    return
                except Exception:
                    await asyncio.sleep(2)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.debug("LAN listener pass: %s", exc)
            await asyncio.sleep(10)


async def _lan_subnet_scanner() -> None:
    """Silent LAN scan fallback: discovers Admin PC if UDP broadcasts are blocked by router."""
    global _discovered_hub_url
    await asyncio.sleep(15)  # Let UDP listener try first

    while True:
        try:
            role = os.getenv("ONENEXA_NODE_ROLE", "admin").lower()
            # If already paired or running as the Admin Hub, sleep
            if _discovered_hub_url or role == "admin":
                await asyncio.sleep(60)
                continue

            my_ips = sync.get_local_ip_addresses()
            server_port = int(os.getenv("PORT", "7432"))
            my_device = store.get_device_id()

            for ip in my_ips:
                if not ip or ip.startswith("127.") or "." not in ip:
                    continue
                parts = ip.split(".")
                subnet_prefix = f"{parts[0]}.{parts[1]}.{parts[2]}"

                # Common candidate host IPs for office Admin PCs / gateways
                candidate_hosts = [1, 2, 3, 5, 10, 20, 50, 100, 150, 200, 254]
                try:
                    current_host = int(parts[3])
                    # Also probe nearby neighbors (+- 5)
                    for delta in (-3, -2, -1, 1, 2, 3):
                        h = current_host + delta
                        if 1 <= h <= 254 and h not in candidate_hosts:
                            candidate_hosts.append(h)
                except ValueError:
                    pass

                async with httpx.AsyncClient(timeout=0.6) as client:
                    for host_num in candidate_hosts:
                        candidate_ip = f"{subnet_prefix}.{host_num}"
                        if candidate_ip == ip:
                            continue
                        candidate_url = f"http://{candidate_ip}:{server_port}"
                        try:
                            res = await client.get(f"{candidate_url}/api/desktop/local-first/hub/info")
                            if res.status_code == 200:
                                data = res.json()
                                if data.get("device_id") and data.get("device_id") != my_device:
                                    logger.info("Discovered Office Admin Hub via LAN probe at %s", candidate_url)
                                    _discovered_hub_url = candidate_url
                                    store.save_sync_cursor("discovered_hub_url", candidate_url)
                                    trigger_immediate_background_sync()
                                    break
                        except Exception:
                            continue

                if _discovered_hub_url:
                    break

            await asyncio.sleep(60)
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(60)


async def _sync_loop(interval_seconds: int = 15) -> None:
    """Continuous silent background sync loop for seamless multi-PC and cloud merging."""
    global _sync_in_progress, _sync_trigger_event
    _sync_trigger_event = asyncio.Event()

    while True:
        try:
            # Wait for either timer interval or immediate save event
            try:
                await asyncio.wait_for(_sync_trigger_event.wait(), timeout=interval_seconds)
                _sync_trigger_event.clear()
            except asyncio.TimeoutError:
                pass

            targets = get_active_sync_targets()
            if not targets:
                continue

            if _sync_in_progress:
                continue

            _sync_in_progress = True
            try:
                company_id = os.getenv("ONENEXA_DEFAULT_COMPANY_ID", "").strip()
                if not company_id:
                    pending = store.get_pending_changes(limit=1)
                    if pending:
                        company_id = pending[0].get("company_id", "")

                if not company_id:
                    company_id = "default_office_company"

                # Sync with each active target (Admin PC and/or Platform Owner Cloud)
                for sync_target in targets:
                    try:
                        result = await sync.run_client_sync_cycle(
                            sync_target_url=sync_target,
                            company_id=company_id,
                            token=os.getenv("ONENEXA_SYNC_TOKEN", "auto-device-token"),
                        )
                        if result.get("pushed", 0) > 0 or result.get("pulled", 0) > 0:
                            logger.info(
                                "Auto-merged with %s: %d pushed, %d pulled",
                                sync_target,
                                result.get("pushed", 0),
                                result.get("pulled", 0),
                            )
                    except Exception as target_exc:
                        logger.debug("Sync pass skipped for %s: %s", sync_target, target_exc)
            finally:
                _sync_in_progress = False

        except asyncio.CancelledError:
            break
        except Exception as exc:
            _sync_in_progress = False
            logger.debug("Auto-sync pass handled: %s", exc)


def start_sync_worker(interval_seconds: int = 15) -> None:
    """Start all background sync and discovery services."""
    global _worker_task, _beacon_task, _listener_task, _scanner_task
    if os.getenv("ONENEXA_LOCAL_FIRST_ENABLED") != "1":
        return

    try:
        loop = asyncio.get_running_loop()
        if _worker_task is None or _worker_task.done():
            _worker_task = loop.create_task(_sync_loop(interval_seconds))
        if _beacon_task is None or _beacon_task.done():
            _beacon_task = loop.create_task(_lan_beacon_sender(DISCOVERY_UDP_PORT))
        if _listener_task is None or _listener_task.done():
            _listener_task = loop.create_task(_lan_beacon_listener(DISCOVERY_UDP_PORT))
        if _scanner_task is None or _scanner_task.done():
            _scanner_task = loop.create_task(_lan_subnet_scanner())
        logger.info("OneNexa zero-config silent synchronization worker initialized.")
    except RuntimeError:
        pass


def stop_sync_worker() -> None:
    """Cancel all background tasks cleanly."""
    global _worker_task, _beacon_task, _listener_task, _scanner_task
    for task in (_worker_task, _beacon_task, _listener_task, _scanner_task):
        if task and not task.done():
            task.cancel()
    _worker_task = _beacon_task = _listener_task = _scanner_task = None
