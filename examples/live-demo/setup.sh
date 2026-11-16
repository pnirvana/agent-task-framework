#!/bin/sh
# Create the ATF live demo: a small "shop" project whose build, tests, CI pipeline and
# app are stand-ins (no Maven, no GitLab needed), with a plan for agents to work on.
#
#   sh examples/live-demo/setup.sh ~/atf-live-demo
#
# What agents meet there:
#   ./mvnw -B verify   Maven-like output for 3 modules and 8 test classes (~50 s), surefire
#                      reports; PriceTest fails until the test data is fixed
#   fake GitLab        pipelines with 5 jobs in 3 stages (~70 s): see examples/live-plugins/
#   ./run-app.sh       a service that logs until stopped
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
DIR=${1:?usage: sh setup.sh <new project directory>}
[ -e "$DIR" ] && { echo "$DIR exists: choose a new directory"; exit 1; }
ATF="node $REPO/bin/atf.mjs"

mkdir -p "$DIR"
cp -R "$HERE/project/." "$DIR/"
mv "$DIR/gitignore" "$DIR/.gitignore"
chmod +x "$DIR/mvnw" "$DIR/run-app.sh"
cd "$DIR"
git init -q && git add -A && git commit -qm "live demo project" 2>/dev/null || true

$ATF init >/dev/null
PLAN=$($ATF plan new "Release check" --goal "Build green, pipeline green, app smoke-tested" --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).plan')
CMDS="Commands in this repo:
- Build and test: ./mvnw -B verify   (takes about a minute)
- Start a CI pipeline: curl -s -X POST localhost:8765/api/v4/projects/demo/pipeline   (prints its id)
- Pipeline status: curl -s localhost:8765/api/v4/projects/demo/pipelines/<id>   (status pending/running/success; takes about a minute; wait for it in a single polling loop, e.g. every 10 s)
- The app: ./run-app.sh runs until stopped"
$ATF add "Make the build green" --plan "$PLAN" --desc "$CMDS" \
  --accept "./mvnw -B verify passes (if a test fails, find out why from its report and fix the test data, not the build script)" >/dev/null
$ATF add "Run the release pipeline" --plan "$PLAN" --dep T1 --desc "$CMDS" \
  --accept "a CI pipeline was started and finished with status success" >/dev/null
$ATF add "Smoke-test the app" --plan "$PLAN" --dep T1 --desc "$CMDS" \
  --accept "the app was started in the background with its output in app.log, the log checked for errors after ~15 s, then the app stopped" >/dev/null

cat <<EOF
Live demo ready in $DIR (plan $PLAN):
  T1 Make the build green        (a test fails at first)
  T2 Run the release pipeline    (after T1)
  T3 Smoke-test the app          (after T1, in parallel with T2)

1. Start the fake GitLab (keep it running):
     node $REPO/examples/live-plugins/fake-gitlab.mjs
2. Optional, pipeline jobs per stage on the board:
     mkdir -p ~/.config/atf/live && ln -s $REPO/examples/live-plugins/gitlab.mjs ~/.config/atf/live/
3. In herdr, from $DIR: open the board (prefix+t), then either
     atf-herdr coordinate             a coordinator plans and starts the agents, or
     atf-herdr spawn T1 --name builder   (then T2 and T3 once T1 is done)
4. Watch the tasks: row badges, ⏎ details, L the live view (atf live T1 --watch).
EOF
