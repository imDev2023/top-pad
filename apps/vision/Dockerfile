# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# Vamp Shield's vision service (spec 10.2): PDQ and SSCD image signatures on CPU, run as one Cloudflare Container
# (instance type basic: a quarter of a vCPU, 1 GiB of memory, 4 GB of disk) behind a Durable Object in the API Worker.
#
# The stages keep everything heavy out of what runs: torch only exports the model, the compiler only builds pdqhash,
# and the runtime carries ONNX Runtime, the ONNX file and the service's own code.
#   wheels   the runtime's hash-pinned wheels, with pdqhash 0.2.8 compiled from its sdist (it ships no Linux wheel)
#   model    downloads SSCD's TorchScript file, checks its SHA-256, exports it to ONNX and refuses the build unless the
#            two models agree (build/export_sscd.py); only the .onnx file leaves it
#   app      the service
#   test     the service plus pytest, which runs during `docker build --target test`
#   runtime  the default target, the service as it ships
#
# docker build --platform linux/amd64 -t heat-vision:dev apps/vision
# docker build --platform linux/amd64 --target test apps/vision

# ORT_DISABLE_TELEMETRY: ONNX Runtime 1.31 on Linux otherwise starts Microsoft's 1DS telemetry at import.
# OPENBLAS_NUM_THREADS: numpy's OpenBLAS starts a thread per CPU it can see (all of the host's, not the quarter vCPU the
# instance may use) as numpy is imported, which alone took over a second of a quarter vCPU; the service barely uses BLAS.
FROM python:3.14.7-slim-trixie@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    ORT_DISABLE_TELEMETRY=1 \
    OPENBLAS_NUM_THREADS=1


FROM base AS wheels
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ \
 && rm -rf /var/lib/apt/lists/*
COPY build/requirements-build.txt /tmp/requirements-build.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements-build.txt
COPY requirements.txt /tmp/requirements.txt
# Without build isolation pdqhash compiles against the pinned Cython and numpy above, not whatever its unpinned build
# requirements resolve to on the day; every other package must arrive as a wheel, so nothing else compiles by surprise.
RUN pip wheel --require-hashes --no-deps --no-build-isolation \
        --only-binary :all: --no-binary pdqhash \
        --wheel-dir /wheels -r /tmp/requirements.txt


# CPython 3.13, not the service's 3.14: torch 2.14 warns that torch.jit.load is not supported on 3.14 and may break, and
# a TorchScript model that loaded wrongly would export wrongly and still agree with itself in the parity check.
FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS model
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    ORT_DISABLE_TELEMETRY=1
COPY requirements.txt build/requirements-export.txt /tmp/
# The export runs the service's own preprocessing on the service's own package versions; pdqhash, which needs a compiler
# and plays no part in SSCD, is left out by its line.
RUN grep -v '^pdqhash==' /tmp/requirements.txt > /tmp/requirements-sscd.txt \
 && pip install --require-hashes --no-deps -r /tmp/requirements-sscd.txt -r /tmp/requirements-export.txt \
 && pip check
# Meta serves the model from a mutable URL, so the build trusts it only while its bytes match the hash pinned here.
ADD --checksum=sha256:9f26bd4c848cc19b73d2ae92eea6e04886f61a7b764ceb7a13aeee62e6a6db56 \
    https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt /model/sscd_disc_mixup.torchscript.pt
# Only the preprocessing the parity check shares with the service is copied, so editing the server does not re-export.
COPY vision/__init__.py vision/sscd.py /opt/vision/vision/
COPY build/export_sscd.py /opt/vision/build/export_sscd.py
WORKDIR /opt/vision
RUN PYTHONPATH=/opt/vision python build/export_sscd.py /model/sscd_disc_mixup.torchscript.pt /model/sscd_disc_mixup.onnx


FROM base AS app
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin vision
RUN --mount=type=bind,from=wheels,source=/wheels,target=/wheels \
    pip install --no-index --no-deps /wheels/*.whl && pip check
COPY --from=model /model/sscd_disc_mixup.onnx /opt/vision/models/sscd_disc_mixup.onnx
COPY vision/ /opt/vision/vision/
# The official image ships the standard library without bytecode, and the service's user cannot write any, so every
# cold start would compile ssl, urllib, email and the rest from source: measured at a quarter vCPU, start-up took about
# 4.1 s without this and 2.2 s with it, for 14 MB of .pyc files. pip already compiled site-packages.
RUN python -m compileall -q -j0 -x site-packages /usr/local/lib/python3.14 /opt/vision/vision
WORKDIR /opt/vision
ENV VISION_MODEL=/opt/vision/models/sscd_disc_mixup.onnx
USER vision
EXPOSE 8080
CMD ["python", "-m", "vision"]


FROM app AS test
USER root
COPY build/requirements-test.txt /tmp/requirements-test.txt
RUN pip install --require-hashes --no-deps -r /tmp/requirements-test.txt && pip check
COPY tests/ /opt/vision/tests/
USER vision
RUN python -m pytest -p no:cacheprovider -q tests


FROM app AS runtime
