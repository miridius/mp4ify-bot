# Sourced by test runners. Reddit demands a login for every request from this
# server's IP, so they borrow the prod bot's cookie jar (the test service has
# no /storage volume). On success sets JAR (a temp dir the caller removes) and
# JAR_VOLUME (its read-only -v mount); on failure cleans up and returns 1.
borrow_cookie_jar() {
  JAR=$(mktemp -d)
  if ! docker cp mp4ify:/storage/mp4ify-cookies.txt "$JAR"; then
    echo "couldn't copy the Reddit cookie jar out of the prod container" >&2
    rm -r "$JAR"
    return 1
  fi
  JAR_VOLUME="$JAR/mp4ify-cookies.txt:/storage/mp4ify-cookies.txt:ro"
}
