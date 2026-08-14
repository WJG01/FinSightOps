import json
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('auditai-output')

# Tighten Access-Control-Allow-Origin to your actual frontend domain before production.
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
    "Content-Type": "application/json",
}


class DecimalEncoder(json.JSONEncoder):
    """DynamoDB returns numbers as Decimal, which json.dumps can't handle."""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super().default(obj)


def respond(status_code, payload):
    """Every response goes through here so CORS headers are never forgotten."""
    return {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
        'body': json.dumps(payload, cls=DecimalEncoder),
    }


def lambda_handler(event, context):
    # Answer the browser's preflight before doing any work.
    method = (
        event.get('requestContext', {}).get('http', {}).get('method')  # Function URL / HTTP API
        or event.get('httpMethod')                                     # REST API
    )
    if method == 'OPTIONS':
        return respond(200, {})

    # Lambda Function URL / API Gateway wraps the payload in event['body'].
    # Direct invocations (console, SDK) put params at the top level.
    if 'body' in event:
        try:
            body = event['body']
            params = json.loads(body) if isinstance(body, str) else (body or {})
        except (json.JSONDecodeError, TypeError):
            return respond(400, {'message': 'Invalid JSON in request body.'})
    else:
        params = event

    financial_year = params.get('financial_year')
    quarter = params.get('quarter')

    if not financial_year or not quarter:
        return respond(400, {
            'message': 'Both "financial_year" and "quarter" parameters are required.'
        })

    prefix = f"{financial_year}-{quarter}"
    items = []
    scan_kwargs = {'FilterExpression': Attr('run_id').begins_with(prefix)}

    try:
        while True:
            response = table.scan(**scan_kwargs)
            items.extend(response.get('Items', []))
            last_key = response.get('LastEvaluatedKey')
            if not last_key:
                break
            scan_kwargs['ExclusiveStartKey'] = last_key
    except Exception as exc:
        # Without this, an unhandled exception returns a 502 with no CORS
        # headers, which the browser misreports as a CORS error.
        print(f"DynamoDB scan failed: {exc}")
        return respond(500, {'message': 'Failed to query records.'})

    if not items:
        return respond(404, {'message': f'No records found for run_id prefix "{prefix}"'})

    latest_item = max(items, key=lambda x: x['completed_at'])
    return respond(200, latest_item)