# AGENTS.md — canable-web

Read `../integration/AGENTS.md` and `../integration/PROJECT_START_HERE.md` first. Project decisions, task cards and reports live in `../integration`.

Interface points: the CAN frames, decoders and update paths this tool shares with the motor firmware, HMI and BESST are listed in `../integration/contracts/INTERFACE_POINTS.json` (rules: "Punkty styku" in `../integration/contracts/COMMUNICATION_REGISTRY.md`). Before handing over a change run `python ../integration/tools/check_interface_impact.py --repo .`; for every reported point the task/report states the effect on the other components. Needed changes in other repos go to a candidate card in `../integration/tasks/`, not into this tree. Vendor frame meaning stays unchanged.

Project line and cross-module requests: read `../integration/PROWADZENIE_PL.md` before starting work and follow its §8.
