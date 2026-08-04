import boto3
import json
import uuid
import base64
import email
from email import policy
from datetime import datetime, timezone
from decimal import Decimal


s3 = boto3.client('s3')
textract = boto3.client('textract')
bedrock = boto3.client('bedrock-runtime')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('AuditAI_Documents')

BUCKET = 'auditai-raw-docs-203475186003-ap-southeast-1-an'

NORMALIZATION_PROMPT = """You are a financial document normalizer. Given raw OCR text extracted 
from a document, map it to this exact JSON schema. Return ONLY valid JSON, no preamble.

Schema:
{{
  "doc_type": "receipt",
  "vendor": string,
  "date": "YYYY-MM-DD",
  "total_amount": number,
  "currency": string,
  "line_items": [{{"description": string, "amount": number}}]
}}

Raw OCR text:
{ocr_text}
"""


def parse_multipart(body_bytes, content_type):
    """Parse a multipart/form-data body into a dict of fields and file parts."""
    msg = email.message_from_bytes(
        b'Content-Type: ' + content_type.encode() + b'\r\n\r\n' + body_bytes,
        policy=policy.default
    )
    fields = {}
    for part in msg.iter_parts():
        name = part.get_param('name', header='Content-Disposition')
        filename = part.get_param('filename', header='Content-Disposition')
        if filename:
            fields[name] = {'filename': filename, 'content': part.get_payload(decode=True)}
        else:
            fields[name] = part.get_payload(decode=True).decode().strip()
    return fields


def lambda_handler(event, context):
    content_type = event.get('headers', {}).get('content-type', '')
    if 'multipart/form-data' not in content_type:
        return response(400, {'error': 'Expected multipart/form-data'})

    raw_body = event['body']
    body_bytes = base64.b64decode(raw_body) if event.get('isBase64Encoded') else raw_body.encode()

    try:
        fields = parse_multipart(body_bytes, content_type)
        run_id = fields['run_id']
        doc_type = fields['doc_type']
        file_part = fields['file']
        filename = file_part['filename']
        file_bytes = file_part['content']
    except KeyError as e:
        return response(400, {'error': f'Missing field: {str(e)}'})

    doc_id = str(uuid.uuid4())[:8]
    s3_key = f'{doc_type}/{run_id}/{doc_id}_{filename}'

    s3.put_object(Bucket=BUCKET, Key=s3_key, Body=file_bytes)

    textract_response = textract.analyze_document(
        Document={'Bytes': file_bytes},
        FeatureTypes=['FORMS', 'TABLES']
    )
    ocr_text = extract_text_from_textract(textract_response)

    try:
        normalized = normalize_with_claude(ocr_text)
    except Exception as e:
        table.put_item(Item={
            'run_id': run_id,
            'doc_type_id': f'{doc_type}#{doc_id}',
            'status': 'failed',
            'error': str(e),
            'raw_textract_ref': s3_key,
            'created_at': datetime.now(timezone.utc).isoformat()
        })
        return response(500, {'error': 'Normalization failed', 'doc_id': doc_id})

    table.put_item(Item={
        'run_id': run_id,
        'doc_type_id': f'{doc_type}#{doc_id}',
        'status': 'normalized',
        'normalized_data': convert_floats_to_decimal(normalized),
        'raw_textract_ref': s3_key,
        'created_at': datetime.now(timezone.utc).isoformat()
    })

    return response(200, {
        'doc_id': doc_id,
        'run_id': run_id,
        'doc_type': doc_type,
        'status': 'normalized',
        's3_key': s3_key,
        'normalized_data': normalized
    })


def convert_floats_to_decimal(obj):
    if isinstance(obj, list):
        return [convert_floats_to_decimal(x) for x in obj]
    if isinstance(obj, dict):
        return {k: convert_floats_to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, float):
        return Decimal(str(obj))
    return obj

def extract_text_from_textract(resp):
    return '\n'.join(b['Text'] for b in resp['Blocks'] if b['BlockType'] == 'LINE')


def normalize_with_claude(ocr_text):
    prompt = NORMALIZATION_PROMPT.format(ocr_text=ocr_text)
    resp = bedrock.invoke_model(
        modelId = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
        body=json.dumps({
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 1000,
            'messages': [{'role': 'user', 'content': prompt}]
        })
    )
    body = json.loads(resp['body'].read())
    text_output = body['content'][0]['text'].strip()
    text_output = text_output.removeprefix('```json').removesuffix('```').strip()
    return json.loads(text_output)


def response(status_code, body_dict):
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body_dict)
    }