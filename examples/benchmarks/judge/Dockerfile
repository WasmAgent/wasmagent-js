# examples/benchmarks/judge/Dockerfile
#
# Container image for the SWE-bench-lite judge.
#
# Built locally by the JS harness's runTests() at first invocation:
#   docker build -t agentkit-swe-judge:latest examples/benchmarks/judge/
#
# The image is intentionally minimal — Python 3.11 + git + build
# essentials. Per-task repo clone + pip install happens at runtime
# inside judge.py because pre-baking 6 different Python repos + their
# version pins would push the image past 20 GB. The trade-off: first
# task takes longer (clone + venv install), subsequent tasks against
# the SAME repo reuse the cloned tree mounted from the host.
#
# The CMD entry is run-judge.sh, which expects /work to be a
# volume-mounted directory containing instance.json + patch.diff
# and writes result.json back into the same directory.

FROM python:3.11-slim

# git for cloning task repos at the right commit; build-essential for
# native Python deps (e.g. astropy, sklearn). curl for arbitrary
# network bootstraps the judge.py might need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pin pip + create a writeable workspace.
RUN python3 -m pip install --upgrade pip
WORKDIR /opt/judge

# Copy the judge entry points. The runtime script expects them at
# fixed paths; the harness on the host does NOT inject judge.py via
# bind mount because the image is pinned by tag and a host edit of
# judge.py should rebuild rather than silently change behaviour.
COPY judge.py /opt/judge/judge.py
COPY run-judge.sh /opt/judge/run-judge.sh
RUN chmod +x /opt/judge/run-judge.sh

# /work is the volume mount: instance.json + patch.diff in, result.json out.
WORKDIR /work
VOLUME /work

CMD ["/opt/judge/run-judge.sh"]
