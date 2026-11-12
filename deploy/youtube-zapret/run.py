"""An opt-in media-domain NFQUEUE service sharing only its parent service's network namespace."""

import os
import signal
import subprocess
import time
from pathlib import Path

CHAIN = "HM_YOUTUBE_ZAPRET"
MARK = "0x40000000/0x40000000"
QUEUE = "108"
STRATEGIES = {
    "split": ["--lua-desync=multisplit:pos=1,midsld"],
    "disorder": ["--lua-desync=multidisorder:pos=1,midsld"],
    "fake-disorder": ["--lua-desync=fake:blob=fake_default_tls:tcp_md5:tcp_seq=-10000",
                      "--lua-desync=multidisorder:pos=1,midsld"],
    "fake-split": ["--lua-desync=fake:blob=fake_default_tls:tcp_md5:tcp_seq=-10000",
                   "--lua-desync=multisplit:pos=1,midsld"],
}


def iptables(*args, check=True):
    return subprocess.run(["iptables", "-w", "5", "-t", "mangle", *args], check=check,
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def cleanup():
    while iptables("-C", "OUTPUT", "-j", CHAIN, check=False).returncode == 0:
        iptables("-D", "OUTPUT", "-j", CHAIN)
    iptables("-F", CHAIN, check=False)
    iptables("-X", CHAIN, check=False)
    Path("/tmp/ready").unlink(missing_ok=True)


def main():
    strategy = os.environ.get("ZAPRET_TLS_STRATEGY", "disorder")
    if strategy not in STRATEGIES:
        raise SystemExit("Unknown ZAPRET_TLS_STRATEGY")
    # This sysctl and these rules belong to the shared Hub namespace, not the LXC/host namespace.
    if Path("/proc/sys/net/netfilter/nf_conntrack_acct").read_text().strip() != "1":
        raise RuntimeError("Enable net.netfilter.nf_conntrack_acct in the Hub network namespace")
    cleanup()
    cmd = ["/opt/zapret2/nfqws2", f"--qnum={QUEUE}", "--uid=65534:65534", "--bind-fix4",
           "--lua-init=@/opt/zapret2/lua/zapret-lib.lua",
           "--lua-init=@/opt/zapret2/lua/zapret-antidpi.lua",
           "--filter-tcp=443", "--filter-l7=tls", "--hostlist=/etc/youtube-zapret/hosts.txt",
           "--payload=tls_client_hello", *STRATEGIES[strategy]]
    process = subprocess.Popen(cmd)
    stopped = False

    def stop(*_):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        # Wait for the actual queue binding before installing interception rules.
        for _ in range(50):
            if process.poll() is not None:
                raise RuntimeError(f"nfqws2 exited: {process.returncode}")
            queues = Path("/proc/net/netfilter/nfnetlink_queue")
            if queues.exists() and any(line.split()[0] == QUEUE for line in queues.read_text().splitlines()):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("NFQUEUE did not bind")
        iptables("-N", CHAIN)
        # Keep private/local connections, including Ollama/Navidrome/PO-token service, out of the queue.
        for network in ["0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]:
            iptables("-A", CHAIN, "-d", network, "-j", "RETURN")
        iptables("-A", CHAIN, "-m", "mark", "--mark", MARK, "-j", "RETURN")
        iptables("-A", CHAIN, "-p", "tcp", "--dport", "443", "-m", "connbytes",
                 "--connbytes-dir", "original", "--connbytes-mode", "packets", "--connbytes", "1:20",
                 "-j", "NFQUEUE", "--queue-num", QUEUE, "--queue-bypass")
        iptables("-I", "OUTPUT", "1", "-j", CHAIN)
        Path("/tmp/ready").touch()
        print(f"YouTube TLS strategy ready: {strategy}", flush=True)
        while not stopped and process.poll() is None:
            time.sleep(0.2)
        if not stopped:
            raise RuntimeError(f"nfqws2 exited: {process.returncode}")
    finally:
        cleanup()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
