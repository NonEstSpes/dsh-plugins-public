# Transport measurements

These are single local observations on Windows11/x64, Node24.21.0, one real native SDK0.1.7 Session, one sequential transfer,16KiB chunks, loopback without TLS. The external LLM alone was scripted. Every payload entered a native SDK receipt and native User message, then was read through verified native EOF and compared byte-for-byte. Neither run establishes WAN, physical Worker or TLS performance.

| Payload | Before upload | After upload | Before download | After download |
| --- | ---: | ---: | ---: | ---: |
|16KiB|1.465s|1.391s|1.084s|1.292s|
|128KiB|4.052s|4.040s|3.665s|3.895s|
|512KiB|13.024s|12.869s|17.255s|15.107s|

For all three payloads together, observed retained pair-state growth fell from2,661,513 to112,472 logical bytes (95.8% lower). Terminal outbox rows now keep HMAC-authenticated replay receipts instead of retaining full encrypted payloads; pending messages retain their original ciphertext and identity. Migration verifies the complete legacy state before committing state version2. Session formats and native mutation journals do not change.

The HTTP baseline made1085 route requests. The automatic socket run made no observed HTTP route requests; connected socket carriers instead made1077 requests and exchanged encoded JSON frames. This removes repeated HTTP envelopes, not the underlying logical request count or durability work. Byte counters exclude TCP/TLS overhead and WebSocket upgrade traffic. WSS uses normal certificate verification; the local check used WS. HTTPS remains the default and the pre-publication fallback.

Observed process-wide peak RSS was334.4MB before and231.2MB after; peak heap usage was189.1MB and104.8MB. These samples include the runner, Controller, Worker, relay and buffers, without forced garbage collection. Disk snapshots were non-atomic logical sizes and excluded native blobs; transient files can cross sample boundaries.

Total run time was45.4s before and47.7s after, including different startup/registration costs. There is no demonstrated overall speedup, percentile or throughput guarantee. The512KiB transfer phases together were7.6% shorter in this sample, while some smaller phases were slower. Serial durable RPC remains a throughput limitation; this release does not introduce a separate unjournaled file protocol or weaken acknowledgements to obtain a speed claim.

Aggregate evidence: [before](source-transfer-baseline.json) and [after](source-transfer-after.json). The measurements exclude internal execution identifiers and are not evidence of a deployed physical Worker.
