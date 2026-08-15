import json
import os
import uuid
import base64
from datetime import date, datetime, timezone
from email.parser import BytesParser
from email.policy import default as email_default_policy
import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "ap-southeast-1")
BUCKET_NAME = "upload-bucket-raw"
TABLE_NAME = "auditai-upload"

s3_client = boto3.client("s3", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION)
table = dynamodb.Table(TABLE_NAME)

# Tighten Access-Control-Allow-Origin to your actual frontend domain before production.
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
}

DOCUMENT_TYPES = {"invoice", "balance_sheet", "bank_statement", "receipt"}
ALLOWED_CONTENT_TYPES = {"application/pdf", "image/jpeg", "image/png", "image/webp"}
MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024  # 4MB safety margin under the ~6MB payload limit


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **CORS_HEADERS},
        "body": json.dumps(body),
    }


def derive_financial_period(document_date_str):
    """Assumes FY = calendar year (Jan-Dec). Shift the month buckets below if
    your organisation's fiscal year starts on a different month."""
    doc_date = date.fromisoformat(document_date_str)
    month = doc_date.month
    financial_year = doc_date.year

    if month <= 3:
        quarter = "Q1"
    elif month <= 6:
        quarter = "Q2"
    elif month <= 9:
        quarter = "Q3"
    else:
        quarter = "Q4"

    return financial_year, quarter


def parse_multipart(event):
    """Parses multipart/form-data body from a Lambda Function URL event.
    Returns (fields: dict, file_bytes: bytes|None, uploaded_filename: str|None)."""
    headers = event.get("headers", {})
    content_type_header = headers.get("content-type") or headers.get("Content-Type", "")

    raw_body = event.get("body", "")
    if event.get("isBase64Encoded"):
        raw_body = base64.b64decode(raw_body)
    else:
        raw_body = raw_body.encode("utf-8")

    # Build a minimal MIME message so email.parser can split the multipart parts for us.
    mime_bytes = (
        f"Content-Type: {content_type_header}\r\nMIME-Version: 1.0\r\n\r\n"
    ).encode("utf-8") + raw_body

    msg = BytesParser(policy=email_default_policy).parsebytes(mime_bytes)

    fields = {}
    file_bytes = None
    uploaded_filename = None

    if msg.is_multipart():
        for part in msg.iter_parts():
            name = part.get_param("name", header="Content-Disposition")
            filename = part.get_filename()

            if filename:
                file_bytes = part.get_payload(decode=True)
                uploaded_filename = filename
            elif name:
                payload = part.get_payload(decode=True)
                fields[name] = payload.decode("utf-8").strip() if payload is not None else ""

    return fields, file_bytes, uploaded_filename


def lambda_handler(event, context):
    http_method = event.get("requestContext", {}).get("http", {}).get("method")
    if http_method == "OPTIONS":
        return {"statusCode": 204, "headers": CORS_HEADERS, "body": ""}

    try:
        fields, file_bytes, uploaded_filename = parse_multipart(event)

        file_name = fields.get("fileName") or uploaded_filename
        content_type = fields.get("contentType")
        document_type = fields.get("documentType")
        document_date = fields.get("documentDate")

        if not all([file_name, content_type, document_type, document_date]) or not file_bytes:
            return response(400, {
                "error": "file, fileName, contentType, documentType and documentDate are all required."
            })

        if document_type not in DOCUMENT_TYPES:
            return response(400, {
                "error": f"documentType must be one of: {', '.join(sorted(DOCUMENT_TYPES))}"
            })

        if content_type not in ALLOWED_CONTENT_TYPES:
            return response(400, {
                "error": "Only PDF and image (jpeg/png/webp) uploads are accepted."
            })

        try:
            financial_year, quarter = derive_financial_period(document_date)
        except ValueError:
            return response(400, {"error": f"Invalid documentDate: {document_date}"})

        if len(file_bytes) == 0:
            return response(400, {"error": "Uploaded file is empty."})

        if len(file_bytes) > MAX_FILE_SIZE_BYTES:
            return response(400, {
                "error": f"File too large ({len(file_bytes)} bytes). Max is {MAX_FILE_SIZE_BYTES} bytes "
                         "for this single-Lambda flow. Use the presigned-URL flow for larger files."
            })

        upload_id = str(uuid.uuid4())
        file_id = str(uuid.uuid4())

        # file_name already contains its own extension (it came from the upload),
        # so we just namespace the key with file_id to avoid same-name uploads
        # in the same quarter silently overwriting each other in S3.
        s3_key = f"documents/{financial_year}/{quarter}/{file_name}"

        # 1. Upload the file to S3
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=file_bytes,
            ContentType=content_type,
            Metadata={
                "uploadid": upload_id,
                "fileid": file_id,
                "filename": file_name,
                "documenttype": document_type,
                "documentdate": document_date,
                "financialyear": str(financial_year),
                "quarter": quarter,
            },
        )

        # 2. Write the DynamoDB record
        item = {
            "uploadId": upload_id,
            "fileId": file_id,
            "fileName": file_name,
            "documentType": document_type,
            "documentDate": document_date,
            "financialYear": financial_year,
            "quarter": quarter,
            "uploadedDate": datetime.now(timezone.utc).isoformat(),
            "s3Bucket": BUCKET_NAME,
            "s3Key": s3_key,
            "contentType": content_type,
            "fileSizeBytes": len(file_bytes),
            "status": "uploaded",
        }
        table.put_item(Item=item)

        return response(200, {
            "uploadId": upload_id,
            "fileId": file_id,
            "s3Bucket": BUCKET_NAME,
            "s3Key": s3_key,
            "financialYear": financial_year,
            "quarter": quarter,
            "fileSizeBytes": len(file_bytes),
            "status": "uploaded",
            "message": "File uploaded to S3 and record written to DynamoDB.",
        })

    except ClientError as err:
        print(f"AWS error: {err}")
        return response(500, {"error": "Failed to process upload.", "detail": str(err)})
    except Exception as err:
        print(f"Unexpected error: {err}")
        return response(500, {"error": "Failed to process upload.", "detail": str(err)})