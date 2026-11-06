"""Machine-readable contract for external AI clients; no network/model dependencies."""
from copy import deepcopy

RESOURCES = ['platforms', 'accounts', 'products', 'strategies', 'tasks', 'actions', 'contents', 'metrics', 'reviews', 'knowledge', 'skills', 'observations']


def ref(name):
    return {'$ref': '#/components/schemas/' + name}


def response(schema, description='Success'):
    return {'description': description, 'content': {'application/json': {'schema': schema}}}


def build_openapi():
    nullable_string = {'type': ['string', 'null']}
    data_fields = {
        'task_id': deepcopy(nullable_string), 'strategy_id': deepcopy(nullable_string),
        'strategy_version': {'type': 'integer', 'minimum': 1},
        'action_id': deepcopy(nullable_string), 'parent_action_id': deepcopy(nullable_string),
        'review_id': deepcopy(nullable_string), 'platform_id': deepcopy(nullable_string),
        'content_id': deepcopy(nullable_string), 'metric_ids': {'type': 'array', 'items': {'type': 'string'}},
        'body': {'type': 'string'}, 'url': {'type': 'string'}, 'evidence_url': {'type': 'string'},
        'occurred_at': {'type': 'string', 'format': 'date-time'},
        'due_at': {'type': ['string', 'null'], 'format': 'date-time'},
        'completed_at': {'type': ['string', 'null'], 'format': 'date-time'},
        'external_id': deepcopy(nullable_string),
        'requires_verification': {'type': 'boolean', 'description': 'Explicitly require external result verification; platform never performs it itself.'},
        'verification_status': {'type': ['string', 'null'], 'enum': ['pending', 'verified', 'failed', 'not_applicable', None]},
        'verified_at': {'type': ['string', 'null'], 'format': 'date-time'},
        'verification_evidence': deepcopy(nullable_string),
        'review_due_at': {'type': ['string', 'null'], 'format': 'date-time'},
        'period_start': {'type': ['string', 'null'], 'format': 'date-time'},
        'period_end': {'type': ['string', 'null'], 'format': 'date-time'},
        'facts': {'type': 'string'}, 'hypothesis': {'type': 'string'},
        'evidence': {'type': 'string'}, 'next_steps': {'type': 'string'},
    }
    write_fields = {
        'title': {'type': 'string', 'description': 'Human-readable record title.'},
        'account_id': deepcopy(nullable_string), 'product_id': deepcopy(nullable_string),
        'status': {'type': 'string', 'default': 'active', 'description': 'Execution/resource state. archived retains history. Other statuses are operator-defined.'},
        'data': {'type': 'object', 'properties': data_fields, 'additionalProperties': True},
    }
    record_fields = deepcopy(write_fields)
    record_fields.update({
        'id': {'type': 'string'}, 'resource': {'type': 'string', 'enum': RESOURCES},
        'version': {'type': 'integer', 'minimum': 1},
        'created_at': {'type': 'string', 'format': 'date-time'},
        'updated_at': {'type': 'string', 'format': 'date-time'},
    })
    schemas = {
        'CreateRecord': {'type': 'object', 'properties': write_fields, 'additionalProperties': False},
        'PatchRecord': {'type': 'object', 'required': ['version'], 'properties': {**deepcopy(write_fields), 'version': {'type': 'integer', 'minimum': 1}}, 'description': 'data keys shallow-merge with the existing data object; include current version, reconcile 409 before retrying.'},
        'Record': {'type': 'object', 'required': ['id', 'resource', 'title', 'version', 'data'], 'properties': record_fields},
        'Item': {'type': 'object', 'required': ['item'], 'properties': {'item': ref('Record')}},
        'RecordList': {'type': 'object', 'required': ['items', 'total', 'limit', 'offset'], 'properties': {'items': {'type': 'array', 'items': ref('Record')}, 'total': {'type': 'integer'}, 'limit': {'type': 'integer'}, 'offset': {'type': 'integer'}}},
        'Error': {'type': 'object', 'required': ['error'], 'properties': {'error': {'type': 'object', 'required': ['code', 'message'], 'properties': {'code': {'type': 'string'}, 'message': {'type': 'string'}, 'details': {}}}}},
        'Export': {'type': 'object', 'required': ['schema_version', 'records', 'versions'], 'properties': {'schema_version': {'type': 'integer', 'const': 1}, 'exported_at': {'type': 'string', 'format': 'date-time'}, 'resources': {'type': 'array', 'items': {'type': 'string'}}, 'records': {'type': 'array', 'items': ref('Record')}, 'versions': {'type': 'array', 'items': ref('Record')}}},
        'Context': {'type': 'object', 'properties': {'account': ref('Record'), 'platform': {'anyOf': [ref('Record'), {'type': 'null'}]}, 'current_strategy': {'anyOf': [ref('Record'), {'type': 'null'}]}, **{r: {'type': 'array', 'items': ref('Record')} for r in ['products', 'strategies', 'tasks', 'actions', 'metrics', 'reviews', 'skills', 'observations', 'knowledge', 'contents']}}},
    }
    metric_data = {
        'type': 'object', 'additionalProperties': True,
        'required': ['metric_name', 'observed_at', 'metric_type', 'value'],
        'properties': {
            **deepcopy(data_fields), 'metric_name': {'type': 'string', 'minLength': 1},
            'value': {'type': ['number', 'null'], 'description': 'Finite number when valid, null otherwise; zero is a real measurement.'},
            'availability': {'type': 'string', 'enum': ['valid', 'missing', 'unavailable', 'not_applicable'], 'default': 'valid'},
            'observed_at': {'type': 'string', 'format': 'date-time', 'description': 'Actual observation time with timezone, not ingestion time.'},
            'metric_type': {'type': 'string', 'enum': ['cumulative', 'interval']},
            'period_start': {'type': ['string', 'null'], 'format': 'date-time', 'description': 'Start of the actual measurement interval, required for daily interval reports.'},
            'period_end': {'type': ['string', 'null'], 'format': 'date-time', 'description': 'End of measurement interval; daily reports require consecutive Beijing midnight boundaries.'},
            'observed_at_precision': {'type': 'string', 'enum': ['instant', 'minute', 'day'], 'description': 'Date-only observations cannot establish fixed-hour performance or exact daily deltas.'},
            'source': {'type': 'string'},
        },
    }
    schemas['CreateMetric'] = deepcopy(schemas['CreateRecord'])
    schemas['CreateMetric']['required'] = ['data']
    schemas['CreateMetric']['properties']['data'] = metric_data
    id_parameter = {'name': 'id', 'in': 'path', 'required': True, 'schema': {'type': 'string'}, 'description': 'Record ID returned by the server.'}
    idem_parameter = {'name': 'Idempotency-Key', 'in': 'header', 'required': True, 'schema': {'type': 'string', 'minLength': 1}, 'description': 'Stable unique key per logical creation. Same key + payload replays original response; different payload conflicts.'}
    filters = [{'name': name, 'in': 'query', 'schema': {'type': 'string'}} for name in ['account_id', 'product_id', 'status', 'q']]
    filters += [{'name': name, 'in': 'query', 'description': 'Inclusive timezone-aware ISO boundary applied to time_field (default created_at). created_at/updated_at also accept legacy YYYY-MM-DD as UTC day bounds. review_period matches overlapping coverage intervals. Missing event dates never fall back to ingestion dates.', 'schema': {'type': 'string'}} for name in ['date_from', 'date_to']]
    filters += [{'name': 'limit', 'in': 'query', 'schema': {'type': 'integer', 'minimum': 1, 'maximum': 200, 'default': 50}}, {'name': 'offset', 'in': 'query', 'schema': {'type': 'integer', 'minimum': 0, 'default': 0}}]
    errors = {'400': response(ref('Error'), 'Invalid input or reference'), '401': response(ref('Error'), 'Missing or invalid Bearer token'), '403': response(ref('Error'), 'Cross-origin write rejected'), '404': response(ref('Error'), 'Record not found'), '409': response(ref('Error'), 'Version, idempotency, or restore conflict')}
    paths = {}
    for resource in RESOURCES:
        base = '/api/v1/' + resource
        body_schema = ref('CreateMetric' if resource == 'metrics' else 'CreateRecord')
        time_fields = ['created_at', 'updated_at'] + {'actions': ['occurred_at'], 'metrics': ['observed_at'], 'tasks': ['due_at'], 'observations': ['due_at'], 'reviews': ['review_period']}.get(resource, [])
        resource_filters = deepcopy(filters) + [{'name': 'time_field', 'in': 'query', 'schema': {'type': 'string', 'enum': time_fields, 'default': 'created_at'}}]
        paths[base] = {
            'get': {'operationId': 'list_' + resource, 'summary': 'List ' + resource, 'parameters': resource_filters, 'responses': {'200': response(ref('RecordList')), **deepcopy(errors)}},
            'post': {'operationId': 'create_' + resource, 'summary': 'Create ' + resource, 'parameters': [deepcopy(idem_parameter)], 'requestBody': {'required': True, 'content': {'application/json': {'schema': body_schema}}}, 'responses': {'201': response(ref('Item'), 'Created, or replay of original successful creation'), **deepcopy(errors)}},
        }
        paths[base + '/{id}'] = {
            'parameters': [deepcopy(id_parameter)],
            'get': {'operationId': 'get_' + resource, 'responses': {'200': response(ref('Item')), **deepcopy(errors)}},
            'patch': {'operationId': 'update_' + resource, 'requestBody': {'required': True, 'content': {'application/json': {'schema': ref('PatchRecord')}}}, 'responses': {'200': response(ref('Item')), **deepcopy(errors)}},
        }
    for resource in ['strategies', 'skills']:
        paths[f'/api/v1/{resource}/{{id}}/history'] = {'parameters': [deepcopy(id_parameter)], 'get': {'operationId': 'history_' + resource, 'responses': {'200': response({'type': 'object', 'properties': {'items': {'type': 'array', 'items': ref('Record')}}}), **deepcopy(errors)}}}
    paths['/api/v1/accounts/{id}/context'] = {'parameters': [deepcopy(id_parameter)], 'get': {'operationId': 'account_context', 'description': 'Bounded recent account context, not an exhaustive archive. Paginate resource lists for historical analysis.', 'responses': {'200': response(ref('Context')), **deepcopy(errors)}}}
    schemas['ActionContext'] = {
        'type': 'object',
        'required': ['action', 'strategy_resolution', 'collections'],
        'properties': {
            'action': ref('Record'),
            **{name: {'anyOf': [ref('Record'), {'type': 'null'}]} for name in ['task', 'strategy', 'content', 'parent_action']},
            'strategy_resolution': {'type': 'string', 'enum': ['exact', 'current_unpinned', 'missing']},
            'collections': {'type': 'object', 'properties': {name: ref('RecordList') for name in ['metrics', 'observations', 'reviews', 'follow_up_tasks', 'follow_up_actions']}},
        },
    }
    paths['/api/v1/actions/{id}/context'] = {
        'parameters': [deepcopy(id_parameter)],
        'get': {'operationId': 'action_context', 'summary': 'Read action evidence and iteration context',
                'description': 'Pinned strategy version is exact; legacy unpinned strategy is explicitly current_unpinned. Collections each expose pagination metadata. Does not infer causal relationships.',
                'parameters': [deepcopy(filters[-2]), deepcopy(filters[-1])],
                'responses': {'200': response(ref('ActionContext')), **deepcopy(errors)}},
    }
    issue_kinds = ['overdue_task', 'missing_evidence', 'unverified_action', 'overdue_observation', 'review_due']
    schemas['ReconciliationIssue'] = {'type': 'object', 'required': ['id', 'kind', 'resource', 'record_id', 'title', 'reason'], 'properties': {
        'id': {'type': 'string'}, 'kind': {'type': 'string', 'enum': issue_kinds}, 'resource': {'type': 'string'},
        'record_id': {'type': 'string'}, 'title': {'type': 'string'}, 'account_id': deepcopy(nullable_string),
        'product_id': deepcopy(nullable_string), 'reason': {'type': 'string'}, 'due_at': {'type': ['string', 'null'], 'format': 'date-time'},
    }}
    schemas['Reconciliation'] = {'type': 'object', 'required': ['items', 'total', 'limit', 'offset', 'counts', 'as_of'], 'properties': {
        'items': {'type': 'array', 'items': ref('ReconciliationIssue')}, 'total': {'type': 'integer'},
        'limit': {'type': 'integer'}, 'offset': {'type': 'integer'}, 'counts': {'type': 'object', 'description': 'Counts across all issue kinds within the account/product filter, before kind filtering and pagination.', 'additionalProperties': {'type': 'integer'}},
        'as_of': {'type': 'string', 'format': 'date-time'},
    }}
    paths['/api/v1/reconciliation'] = {'get': {'operationId': 'reconciliation', 'summary': 'Read execution discrepancies',
        'description': 'Read-only deterministic issue list as of server now or explicit as_of. No scheduling, external API access, notifications or model calls. One record may have multiple issues. Terminal/archived records excluded as documented.',
        'parameters': [deepcopy(filters[0]), deepcopy(filters[1]),
                       {'name': 'kind', 'in': 'query', 'schema': {'type': 'string', 'enum': issue_kinds}},
                       {'name': 'as_of', 'in': 'query', 'schema': {'type': 'string', 'format': 'date-time'}},
                       deepcopy(filters[-2]), deepcopy(filters[-1])],
        'responses': {'200': response(ref('Reconciliation')), **deepcopy(errors)}}}
    for name in ['meta', 'openapi.json']:
        paths['/api/v1/' + name] = {'get': {'operationId': name.replace('.', '_'), 'responses': {'200': response({'type': 'object', 'additionalProperties': True}), **deepcopy(errors)}}}
    paths['/health'] = {'get': {'operationId': 'health', 'security': [], 'responses': {'200': response({'type': 'object', 'properties': {'ok': {'type': 'boolean'}}})}}}
    paths['/api/v1/dashboard'] = {'get': {'operationId': 'dashboard', 'parameters': [deepcopy(filters[0])], 'responses': {'200': response({'type': 'object', 'properties': {'counts': {'type': 'object', 'additionalProperties': {'type': 'integer'}}, 'latest_metrics': {'type': 'array', 'items': ref('Record')}, 'recent_work': {'type': 'array', 'items': ref('Record')}}}), **deepcopy(errors)}}}
    paths['/api/v1/export'] = {'get': {'operationId': 'export_workspace', 'responses': {'200': response(ref('Export')), **deepcopy(errors)}}}
    paths['/api/v1/restore'] = {'post': {'operationId': 'restore_empty_workspace', 'description': 'Only into an empty instance initialized with GROWTH_SEED=0. Transactional validation; never overwrites records. On uncertain success inspect target rather than replaying into non-empty data.', 'requestBody': {'required': True, 'content': {'application/json': {'schema': ref('Export')}}}, 'responses': {'200': response({'type': 'object', 'properties': {'restored': {'type': 'integer'}, 'versions': {'type': 'integer'}}}), **deepcopy(errors)}}}
    return {'openapi': '3.1.0', 'info': {'title': 'Growth Ops API', 'version': '1.1.0', 'description': 'External AI operations notebook. One workspace per instance; no model execution or social-platform publishing.'}, 'servers': [{'url': '/'}], 'security': [{'bearerAuth': []}], 'paths': paths, 'components': {'securitySchemes': {'bearerAuth': {'type': 'http', 'scheme': 'bearer'}}, 'schemas': schemas}}
