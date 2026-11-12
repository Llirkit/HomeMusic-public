FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git build-essential pkg-config libnetfilter-queue-dev \
    libnfnetlink-dev libmnl-dev libcap-dev zlib1g-dev libluajit-5.1-dev \
    && rm -rf /var/lib/apt/lists/*
ARG ZAPRET_COMMIT=c08c412dd8b39a456ef42b42530b150f6f02f7e2
WORKDIR /src
RUN git init && git remote add origin https://github.com/bol-van/zapret2.git \
    && git fetch --depth 1 origin "$ZAPRET_COMMIT" && git checkout --detach FETCH_HEAD \
    && make -C nfq2 -j2

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-minimal iptables libnetfilter-queue1 libnfnetlink0 libmnl0 zlib1g libluajit-5.1-2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/nfq2/nfqws2 /opt/zapret2/nfqws2
COPY --from=build /src/lua/ /opt/zapret2/lua/
COPY --from=build /src/docs/LICENSE.txt /opt/zapret2/LICENSE.txt
COPY hosts.txt /etc/youtube-zapret/hosts.txt
COPY run.py /opt/youtube-zapret/run.py
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python3", "/opt/youtube-zapret/run.py"]
