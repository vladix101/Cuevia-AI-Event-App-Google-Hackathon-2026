# Firebase emulators (Auth, Firestore) for local compose development.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* && npm install -g firebase-tools@15.28.1
WORKDIR /work
# Pre-download emulator JARs at build time so container start is fast.
RUN firebase setup:emulators:firestore
EXPOSE 9099 8080
CMD ["firebase", "emulators:start", "--only", "auth,firestore", "--project", "demo-cuevia"]
