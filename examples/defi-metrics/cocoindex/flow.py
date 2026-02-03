"""Placeholder CocoIndex flow.

This file is intentionally a sketch, because w3rt's CI/runtime is TS/Node.
Run CocoIndex as a sidecar to populate Postgres table `defi_metrics`.

You can implement sources per protocol (Solend/Kamino/Meteora/Drift/Jito/Marinade/Jupiter)
then export normalized rows.

Docs: https://cocoindex.io/docs
"""

# Example outline (pseudo-code):
#
# import cocoindex
#
# @cocoindex.flow_def(name="SolanaDefiMetrics")
# def flow(flow_builder: cocoindex.FlowBuilder, scope: cocoindex.DataScope):
#     scope["raw"] = flow_builder.add_source(cocoindex.sources.HttpJson(urls=[...]))
#     metrics = scope.add_collector()
#     with scope["raw"].row() as row:
#         # normalize to our schema
#         metrics.collect(
#             chain="solana",
#             protocol=row["protocol"],
#             market=row["market"],
#             tvl_usd=row["tvl_usd"],
#             liquidity_usd=row["liquidity_usd"],
#             price_vol_5m_bps=row["price_vol_5m_bps"],
#             borrow_utilization_bps=row["borrow_utilization_bps"],
#             source_url=row["source_url"],
#             updated_at=row["updated_at"],
#         )
#
#     metrics.export(
#         "defi_metrics",
#         cocoindex.targets.Postgres(),
#         primary_key_fields=["chain", "protocol", "market"],
#     )
