"""pocketaces command line.

  pocketaces fetch singsaver|moneysmart|milelion|all
  pocketaces discover [--write]
  pocketaces tnc [CARD_ID ...] [--llm]
  pocketaces tnc import CARD_ID FILE --url OFFICIAL_URL   # for documents robots.txt blocks
  pocketaces reference mcc|awards
  pocketaces curate CARD_ID ... | --all
  pocketaces build
  pocketaces validate
  pocketaces refresh [--llm]           # everything, in order
  pocketaces merchants add NAME MCC --source URL [--channel online] [--note ...]
  pocketaces awards log --origin SIN --destination LHR --cabin business --award-type saver \
      --miles 107000 --departure 2027-03-01 --source URL
  pocketaces awards ranges
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

import yaml

from . import build, config, curate, discover, paths


def _fetch(which: str, limit: int | None) -> None:
    from .sources import milelion, moneysmart, singsaver

    runners = {"singsaver": singsaver.run, "moneysmart": moneysmart.run, "milelion": milelion.run}
    for name in runners if which == "all" else [which]:
        try:
            runners[name](limit=limit)
        except Exception as e:  # one broken source must not stop a refresh
            logging.error("%s failed: %s", name, e, exc_info=logging.getLogger().isEnabledFor(logging.DEBUG))


def _print_report(counts: dict) -> None:
    for k, v in counts.items():
        print(f"  {k:28} {v}")
    print(f"\nreport: {(paths.BUILD / 'report.md').relative_to(paths.ROOT)}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="pocketaces", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="scrape aggregator/editorial sources into data/staging")
    f.add_argument("source", choices=["singsaver", "moneysmart", "milelion", "all"])
    f.add_argument("--limit", type=int, help="max items (for testing)")

    d = sub.add_parser("discover", help="propose registry entries for unmapped aggregator cards")
    d.add_argument("--write", action="store_true", help="append proposals to config/cards.yaml")

    t = sub.add_parser("tnc", help="download official T&Cs and extract MCC rules "
                       "(`tnc import CARD FILE --url URL` to add a hand-downloaded document)")
    t.add_argument("card_ids", nargs="*")
    t.add_argument("--llm", action="store_true", help="also run verified LLM extraction")
    t.add_argument("--url", help="with `import`: the official URL the file was downloaded from")

    r = sub.add_parser("reference", help="refresh reference data")
    r.add_argument("what", choices=["mcc", "awards", "all"])

    c = sub.add_parser("curate", help="create/refresh curated drafts from staged evidence")
    c.add_argument("card_ids", nargs="*")
    c.add_argument("--all", action="store_true")

    sub.add_parser("build", help="merge, validate, tag and write data/build")
    sub.add_parser("validate", help="check config files and curated records")

    rf = sub.add_parser("refresh", help="run the full pipeline")
    rf.add_argument("--llm", action="store_true")

    m = sub.add_parser("merchants", help="curated merchant → MCC table")
    msub = m.add_subparsers(dest="action", required=True)
    ma = msub.add_parser("add")
    ma.add_argument("name")
    ma.add_argument("mcc")
    ma.add_argument("--source", required=True, help="URL evidencing this MCC")
    ma.add_argument("--channel", help="e.g. online, in-store, app")
    ma.add_argument("--note")
    ma.add_argument("--verified", action="store_true")
    msub.add_parser("candidates", help="show MCC mentions mined from Milelion")

    a = sub.add_parser("awards", help="KrisFlyer redemption observations")
    asub = a.add_subparsers(dest="action", required=True)
    al = asub.add_parser("log")
    for arg in ("origin", "destination", "cabin", "departure", "source"):
        al.add_argument(f"--{arg}", required=True)
    al.add_argument("--award-type", required=True, choices=["saver", "advantage", "dynamic"])
    al.add_argument("--miles", required=True, type=int, help="one-way miles")
    al.add_argument("--taxes", type=float)
    al.add_argument("--flight")
    al.add_argument("--zone-from")
    al.add_argument("--zone-to")
    al.add_argument("--observed-on")
    al.add_argument("--note")
    asub.add_parser("ranges")

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if args.cmd == "fetch":
        _fetch(args.source, args.limit)
    elif args.cmd == "discover":
        props = discover.proposals()
        if args.write:
            print(f"added {discover.write(props)} cards to config/cards.yaml")
        else:
            print(yaml.safe_dump({"cards": props}, sort_keys=False, allow_unicode=True) if props
                  else "all aggregator cards are mapped")
    elif args.cmd == "tnc":
        from pathlib import Path

        from .sources import bank_tnc
        if args.card_ids[:1] == ["import"]:
            if len(args.card_ids) != 3 or not args.url:
                p.error("usage: pocketaces tnc import CARD_ID FILE --url OFFICIAL_URL")
            snap = bank_tnc.import_document(args.card_ids[1], Path(args.card_ids[2]), args.url)
            print(f"imported as {snap.path}; now run `pocketaces tnc {args.card_ids[1]}`")
        else:
            bank_tnc.run(args.card_ids or None, use_llm=args.llm)
    elif args.cmd == "reference":
        from .sources import krisflyer, mcc_reference
        if args.what in ("mcc", "all"):
            mcc_reference.refresh_mcc_codes()
        if args.what in ("awards", "all"):
            krisflyer.refresh_award_chart()
    elif args.cmd == "curate":
        ids = [c["id"] for c in config.active_cards()] if args.all else args.card_ids
        if not ids:
            p.error("give card ids or --all")
        for cid in ids:
            curate.curate(cid)
    elif args.cmd == "build":
        _print_report(build.run())
    elif args.cmd == "validate":
        problems = build.validate_config()
        problems += [f"{p.name}: {c}" for p, c in curate.load_curated() if isinstance(c, Exception)]
        print("\n".join(problems) or "ok")
        return 1 if problems else 0
    elif args.cmd == "refresh":
        from .sources import bank_tnc, krisflyer, mcc_reference
        for step in (mcc_reference.refresh_mcc_codes, krisflyer.refresh_award_chart):
            try:
                step()
            except Exception as e:
                logging.error("%s failed: %s", step.__name__, e)
        _fetch("all", None)
        props = discover.proposals()
        if props:
            logging.warning("%d aggregator cards are not in config/cards.yaml — see "
                            "`pocketaces discover`", len(props))
        bank_tnc.run(use_llm=args.llm)
        for card in config.active_cards():
            curate.curate(card["id"])
        _print_report(build.run())
    elif args.cmd == "merchants":
        from .sources import mcc_reference
        if args.action == "add":
            mcc_reference.add_merchant(args.name, args.mcc, args.source, channel=args.channel,
                                       note=args.note, verified=args.verified)
        else:
            path = paths.STAGING / "milelion" / "mcc_mentions.json"
            for m in json.loads(path.read_text()) if path.exists() else []:
                print(f"{m['mcc']}  {m['context'][:150]}\n      {m['url']}")
    elif args.cmd == "awards":
        from .sources import krisflyer
        if args.action == "log":
            krisflyer.log_observation({
                "origin": args.origin.upper(), "destination": args.destination.upper(),
                "cabin": args.cabin, "award_type": args.award_type, "one_way_miles": args.miles,
                "taxes_sgd": args.taxes, "departure_date": args.departure,
                "flight_no": args.flight, "zone_from": args.zone_from, "zone_to": args.zone_to,
                "source_url": args.source, "note": args.note,
                **({"observed_on": args.observed_on} if args.observed_on else {}),
            })
        else:
            print(json.dumps(krisflyer.observation_ranges(), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
