# shellcheck shell=bash
# GH-LANES lane definitions. Ported verbatim from the qualified local runners
# (tgp-private-evidence execution/42d8c5b5/proof/lane-s11.sh e9470a92..., lane-s10b.sh ec15b4d0...).
# Do not re-invent stage definitions here: any change must be made in the local runners first.
# Table row: name|jest config|timeout s|spec files (space-separated)|kind (live|guard)|required (req|opt)
lane_load() {
  case "$1" in
    s11)
      LANE_NAME=s11
      LANE_ENV=G2_S11
      DB_TS=test/utils/g2-s11-db.ts
      BOOT_SH=test/utils/g2-s11-bootstrap.sh
      CONN_LIMIT=2
      FIXPASS=s11_local_synthetic
      STAGE_TABLE=(
        "rls-g2-s11|jest.rls.config.js|1500|test/rls-g2-s11.spec.ts|live|req"
        "journey-core|jest.config.js|1500|test/scout/s11/journey-core.pg.spec.ts|live|req"
        "readiness|jest.config.js|900|test/scout/s11/readiness.pg.spec.ts|live|req"
        "settle-redrive|jest.config.js|3000|test/scout/s11/settle-redrive.pg.spec.ts|live|req"
        "journey-induction|jest.config.js|3000|test/scout/s11/journey-induction.pg.spec.ts|live|req"
        "journey-full|jest.config.js|4200|test/scout/s11/journey-full.pg.spec.ts|live|opt"
        "guard|jest.config.js|300|test/utils/g2-s11-db-guard.spec.ts|guard|req"
      )
      NEED_RG_FOR="journey-full"
      ;;
    s10b)
      LANE_NAME=s10b
      LANE_ENV=G2_S10B
      DB_TS=test/utils/g2-s10b-db.ts
      BOOT_SH=test/utils/g2-s10b-bootstrap.sh
      CONN_LIMIT=4
      FIXPASS=s10b_local_synthetic
      STAGE_TABLE=(
        "rls-s10b-s10c|jest.rls.config.js|1500|test/rls-g2-s10b.spec.ts test/rls-g2-s10c.spec.ts|live|req"
        "s10-unseen|jest.config.js|1500|test/scout/s10/s10-unseen.pg.spec.ts|live|req"
      )
      NEED_RG_FOR=""
      ;;
    *) return 1 ;;
  esac
}
LANES="s11 s10b"
# Accepted dependency tree (donor x42 / local runners); a target whose package-lock differs is REFUSED
# unless PROOF_TARGET pins another PKG_LOCK_SHA256 explicitly.
DEFAULT_PKG_LOCK_SHA256=b7fed5ed611c004615022cf69375b83956e9a69604807123fbe0e7965aea9c55
# PG 17.6 server: the same zonky artifact and pins as runtime/rt-setup-42d8c5b5.sh.
PG_JAR_URL=https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/17.6.0/embedded-postgres-binaries-linux-amd64-17.6.0.jar
PG_JAR_SHA256=23da5a044b4fb7a5a081a45008c95749c873305328d73f86aefd56922ce1d29d
PG_TXZ_SHA256=26fa633461a3340913015503d0783d73a28384110257e2f17d9936bdf8b067c0
PG_POSTGRES_SHA256=23cd174849b273064c47d581b55be596be2f5cf0ee5d3e76c0146e2464bf873a
PG_INITDB_SHA256=b7db9bc2463a4ffbe1e405977512afb50c9846fd3af2b694e315e6d5a270882a
PG_PGCTL_SHA256=af53d826845af4679a0aaba2bda319f5e527f3b94f3794c67fa174049c9b9401
