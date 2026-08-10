# Local Perforce measurement rig (RUN-253). Built from Perforce's OWN repo, never a third-party
# image — the official helix-p4d image on Docker Hub is not publicly pullable ("requested access
# to the resource is denied") and cdn.perforce.com does not resolve, so every alternative on
# Docker Hub is an unknown publisher shipping a version-control server. That trust question does
# not expire; do not swap this back to `docker.io/perforce/helix-p4d` or similar (lockedDecisions
# #1 in RUN-253's spec).
FROM registry.fedoraproject.org/fedora:44

# Pin the exact package build, not just the minor version — "2026.1" alone still lets dnf pick up
# a later point release on rebuild. Override with --build-arg P4D_PKG_VERSION=... to test a bump;
# re-run scripts/p4d-rig/measure.sh against the result before trusting it (see README "version
# bumps").
ARG P4D_PKG_VERSION=2026.1-2972966.el10

RUN rpm --import https://package.perforce.com/perforce.pubkey \
    && printf '%s\n' \
        '[perforce]' \
        'name=Perforce' \
        'baseurl=https://package.perforce.com/yum/rhel/10/x86_64' \
        'enabled=1' \
        'gpgcheck=1' \
        > /etc/yum.repos.d/perforce.repo \
    && dnf -y install \
        "p4-server-${P4D_PKG_VERSION}" \
        "p4-cli-${P4D_PKG_VERSION}" \
    && dnf clean all

# p4d writes into a volume mounted at /p4root (see up.sh); nothing is baked into the image beyond
# the binaries. Server binary /opt/perforce/sbin/p4d, client /opt/perforce/bin/p4.
