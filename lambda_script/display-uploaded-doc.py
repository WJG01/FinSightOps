import json
import os
from decimal import Decimal
import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "ap-southeast-1")
BUCKET_NAME = "upload-bucket-raw"
TABLE_NAME = "auditai-upload"

# How long a generated download link stays valid, in seconds.
PRESIGNED_URL_EXPIRY_SECONDS = 300  # 5 minutes

s3_client = boto3.client("s3", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION)
table = dynamodb.Table(TABLE_NAME)

# Tighten Access-Control-Allow-Origin to your actual frontend domain before production.
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
}

QUARTERS = ["Q1", "Q2", "Q3", "Q4"]


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **CORS_HEADERS},
        "body": json.dumps(body, default=_json_default),
    }


def _json_default(value):
    # DynamoDB numeric attributes come back as Decimal; make them JSON-serialisable.
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Object of type {type(value)} is not JSON serializable")


def lambda_handler(event, context):
    http_method = event.get("requestContext", {}).get("http", {}).get("method")
    if http_method == "OPTIONS":
        return {"statusCode": 204, "headers": CORS_HEADERS, "body": ""}

    query_params = event.get("queryStringParameters") or {}
    action = query_params.get("action", "list")

    if action == "list":
        return handle_list()
    elif action == "download":
        return handle_download(query_params.get("fileId"))
    else:
        return response(400, {"error": "Unknown action. Use 'list' or 'download'."})


def handle_list():
    """
    Returns all uploaded documents grouped by financial year and quarter:
    {
      "years": {
        "2026": {
          "Q1": [ { fileId, fileName, documentType, documentDate, contentType,
                     fileSizeBytes, status, uploadedDate }, ... ],
          "Q2": [...], "Q3": [...], "Q4": [...]
        },
        ...
      }
    }

    NOTE: this uses a table Scan, which is fine for a modest number of records.
    If this table grows large, add a GSI on financialYear (and quarter as a
    sort key) and switch this to a Query instead.
    """
    try:
        items = []
        scan_kwargs = {}
        while True:
            result = table.scan(**scan_kwargs)
            items.extend(result.get("Items", []))
            if "LastEvaluatedKey" not in result:
                break
            scan_kwargs["ExclusiveStartKey"] = result["LastEvaluatedKey"]

        years = {}
        for item in items:
            year = str(item.get("financialYear"))
            quarter = item.get("quarter")
            if quarter not in QUARTERS:
                continue

            years.setdefault(year, {q: [] for q in QUARTERS})
            years[year][quarter].append({
                "fileId": item.get("fileId"),
                "uploadId": item.get("uploadId"),
                "fileName": item.get("fileName"),
                "documentType": item.get("documentType"),
                "documentDate": item.get("documentDate"),
                "contentType": item.get("contentType"),
                "fileSizeBytes": item.get("fileSizeBytes"),
                "status": item.get("status"),
                "uploadedDate": item.get("uploadedDate"),
            })

        # Sort files within each quarter by uploadedDate, most recent first.
        for year_data in years.values():
            for quarter in QUARTERS:
                year_data[quarter].sort(
                    key=lambda f: f.get("uploadedDate") or "", reverse=True
                )

        return response(200, {"years": years})

    except ClientError as err:
        print(f"AWS error: {err}")
        return response(500, {"error": "Failed to list documents.", "detail": str(err)})
    except Exception as err:
        print(f"Unexpected error: {err}")
        return response(500, {"error": "Failed to list documents.", "detail": str(err)})


def handle_download(file_id):
    """
    Looks up a single document by fileId and returns a short-lived presigned
    S3 URL the frontend can use directly as a download link.
    """
    if not file_id:
        return response(400, {"error": "fileId query parameter is required."})

    try:
        # fileId isn't the table's primary key in the upload Lambda (uploadId is),
        # so we scan with a filter. For frequent lookups, add a GSI on fileId
        # instead of scanning.
        result = table.scan(
            FilterExpression="fileId = :fid",
            ExpressionAttributeValues={":fid": file_id},
        )
        items = result.get("Items", [])
        if not items:
            return response(404, {"error": f"No document found with fileId {file_id}."})

        item = items[0]
        s3_key = item.get("s3Key")
        file_name = item.get("fileName")

        presigned_url = s3_client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": BUCKET_NAME,
                "Key": s3_key,
                "ResponseContentDisposition": f'attachment; filename="{file_name}"',
            },
            ExpiresIn=PRESIGNED_URL_EXPIRY_SECONDS,
        )

        return response(200, {
            "fileId": file_id,
            "fileName": file_name,
            "downloadUrl": presigned_url,
            "expiresInSeconds": PRESIGNED_URL_EXPIRY_SECONDS,
        })

    except ClientError as err:
        print(f"AWS error: {err}")
        return response(500, {"error": "Failed to generate download URL.", "detail": str(err)})
    except Exception as err:
        print(f"Unexpected error: {err}")
        return response(500, {"error": "Failed to generate download URL.", "detail": str(err)})