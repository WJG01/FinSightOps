"""
Lambda: scans the ENTIRE auditai-output DynamoDB table (no input
required), groups records by the first 7 characters of run_id
(the partition key) -- e.g. "2024-Q1" -- and for each group returns:
  - count: number of records in that group
  - latest_record: the full record with the max completed_at (the sort key)

The final list of groups is returned sorted descending by each
group's latest completed_at.

DESIGN / WHY THIS IS THE OPTIMUM APPROACH:
Rather than pulling every item into a list and sorting the whole
thing by sk, this does a SINGLE pass over the table (via Scan,
paginated) and maintains a running "best so far" (count + latest
record) per group in a dict as it goes -- O(n) overall, O(1)
extra memory per item. Only at the very end do we sort, and we
sort the small list of GROUPS (however many distinct 7-char
prefixes exist), not the full set of table items. That's much
cheaper than sorting every record.

NOTE: Scan reads every item in the table (DynamoDB doesn't support
prefix matching on a partition key via Query). For a large/growing
table queried often, consider a GSI with a "quarter" attribute
(e.g. "2024-Q1") as its partition key, so you could instead Query
each known prefix directly. Happy to build that version if this
becomes a hot path.
"""

import json
import os
import boto3

TABLE_NAME = os.environ.get("TABLE_NAME", "auditai-output")
PREFIX_LEN = 7  # length of the grouping prefix, e.g. "2024-Q1"

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)


def scan_all_items():
    """Scan the whole table, handling pagination (Scan caps at ~1MB/call)."""
    items = []
    scan_kwargs = {}

    while True:
        response = table.scan(**scan_kwargs)
        items.extend(response.get("Items", []))

        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kwargs["ExclusiveStartKey"] = last_key

    return items


def group_and_find_latest(items):
    """
    Single pass: group by run_id[:PREFIX_LEN], tracking count and
    the record with the max completed_at seen so far for each group.

    completed_at is an ISO-8601 string like
    "2026-08-13T18:11:29.964191+00:00" -- lexicographic string
    comparison matches chronological order for this fixed format,
    so plain string '>' comparison works without date parsing.
    """
    groups = {}  # prefix -> {"count": int, "latest_record": dict}

    for item in items:
        run_id = item.get("run_id", "")
        prefix = run_id[:PREFIX_LEN]
        completed_at = item.get("completed_at", "")

        if prefix not in groups:
            groups[prefix] = {"count": 1, "latest_record": item}
        else:
            groups[prefix]["count"] += 1
            if completed_at > groups[prefix]["latest_record"].get("completed_at", ""):
                groups[prefix]["latest_record"] = item

    return groups


def lambda_handler(event, context):
    items = scan_all_items()
    groups = group_and_find_latest(items)

    results = [
        {
            "prefix": prefix,
            "count": data["count"],
            "latest_record": data["latest_record"],
        }
        for prefix, data in groups.items()
    ]

    # Sort the (small) group list descending by each group's latest completed_at
    results.sort(key=lambda g: g["latest_record"].get("completed_at", ""), reverse=True)

    return {
        "statusCode": 200,
        "body": json.dumps({"groups": results}, default=str)  # default=str handles Decimal
    }