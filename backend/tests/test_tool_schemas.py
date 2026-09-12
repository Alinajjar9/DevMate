import copy
import json
import unittest
from dataclasses import replace

import httpx

from backend.app.main import _parse_agent_tool_calls
from backend.app.providers import ChatCompletionRequest, ChatMessage, ChatToolCall, OpenAICompatibleProvider, ProviderError
from backend.app.tool_catalog import AGENT_TOOL_DEFINITIONS
from backend.app.tool_schemas import strict_tool_schema


TOOLS = {tool.name: tool for tool in AGENT_TOOL_DEFINITIONS}


class ToolSchemaTests(unittest.TestCase):
    def test_all_tool_objects_are_closed_and_optional_fields_are_nullable(self):
        original = copy.deepcopy(AGENT_TOOL_DEFINITIONS)
        for tool in AGENT_TOOL_DEFINITIONS:
            strict = strict_tool_schema(tool.parameters)
            self.assertEqual(strict['required'], list(strict['properties']))
            self.assertFalse(strict['additionalProperties'])
            for name, schema in tool.parameters['properties'].items():
                converted = strict['properties'][name]
                if name not in tool.parameters.get('required', []):
                    self.assertIn({'type': 'null'}, converted['anyOf'])
                else:
                    self.assertEqual(converted.get('type'), schema['type'])
        self.assertEqual(original, AGENT_TOOL_DEFINITIONS)

    def test_edit_schema_keeps_empty_new_text_valid_but_requires_fields_and_nonempty_array(self):
        schema = strict_tool_schema(TOOLS['edit_file'].parameters)
        replacements = schema['properties']['replacements']
        self.assertEqual(replacements['minItems'], 1)
        self.assertEqual(replacements['maxItems'], 20)
        item = replacements['items']
        self.assertEqual(item['required'], ['oldText', 'newText'])
        self.assertFalse(item['additionalProperties'])
        self.assertEqual(item['properties']['oldText']['minLength'], 1)
        self.assertEqual(item['properties']['newText']['type'], 'string')
        self.assertNotIn('minLength', item['properties']['newText'])

    def test_optional_nulls_become_defaults_at_api_boundary(self):
        calls = (
            ChatToolCall('read', 'read_file', '{"path":"index.html","startLine":null,"endLine":null}'),
            ChatToolCall('command', 'run_command', '{"executable":"npm","args":null,"cwd":null,"timeoutSeconds":null}'),
        )
        parsed = _parse_agent_tool_calls(calls, {'read_file', 'run_command'})
        self.assertEqual(parsed[0].arguments, {'path': 'index.html'})
        self.assertEqual(parsed[1].arguments, {'executable': 'npm'})

    def test_required_null_and_empty_replacement_are_not_confused(self):
        for value in (None, ''):
            arguments = {'path': 'index.html', 'replacements': [{'oldText': 'remove', 'newText': value}]}
            parsed = _parse_agent_tool_calls((ChatToolCall('edit', 'edit_file', json.dumps(arguments)),), {'edit_file'})
            # Leave required null invalid so the executor can explain the exact field; retain valid empty strings.
            self.assertEqual(parsed[0].arguments, arguments)

    def test_new_optional_tool_fields_normalize_null_without_losing_false_or_zero(self):
        examples = [
            ('get_project_info', {'path': None}, {}),
            ('get_git_changes', {'path': None, 'staged': False}, {'staged': False}),
            ('search_code', {'query': 'a.b', 'caseSensitive': None, 'wholeWord': False, 'filePattern': None, 'contextLines': 0},
             {'query': 'a.b', 'wholeWord': False, 'contextLines': 0}),
            ('run_command', {'executable': 'npm', 'background': None}, {'executable': 'npm'}),
            ('run_command', {'executable': 'npm', 'background': True}, {'executable': 'npm', 'background': True}),
        ]
        for name, arguments, expected in examples:
            with self.subTest(name=name, arguments=arguments):
                calls = (ChatToolCall('call', name, json.dumps(arguments)),)
                self.assertEqual(_parse_agent_tool_calls(calls, {name})[0].arguments, expected)

    def test_editor_and_stop_tools_require_their_target_fields(self):
        for name, required in [('rename_symbol', ['path', 'line', 'column', 'newName']),
                               ('format_file', ['path']), ('stop_command', ['id'])]:
            self.assertEqual(TOOLS[name].parameters['required'], required)
            for field in required:
                self.assertNotIn('anyOf', strict_tool_schema(TOOLS[name].parameters)['properties'][field])

    def test_normalizing_optional_nulls_does_not_modify_replayed_provider_arguments(self):
        original_arguments = '{"path":"index.html","startLine":null,"endLine":null}'
        state = {'endpoint': 'https://api.openai.com/v1/responses', 'model': 'reasoning-model', 'outputItems': [
            {'type': 'function_call', 'call_id': 'read', 'name': 'read_file', 'arguments': original_arguments},
        ]}
        call = ChatToolCall('read', 'read_file', original_arguments, provider_state=state)
        parsed = _parse_agent_tool_calls((call,), {'read_file'})[0]
        self.assertEqual(parsed.arguments, {'path': 'index.html'})
        self.assertEqual(parsed.providerState['outputItems'][0]['arguments'], original_arguments)


class StrictCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    def request(self, api='responses', base_url='https://provider.example/v1'):
        return ChatCompletionRequest(provider='openai', model='reasoning-model', api_key='test-key',
            api=api, base_url=base_url, messages=(ChatMessage('user', 'Read index.html'),),
            max_tokens=1200, temperature=0.2, reasoning_effort='high', tools=(TOOLS['read_file'],))

    def answer(self, api):
        if api == 'responses':
            return {'status': 'completed', 'output': [{'type': 'message', 'role': 'assistant', 'content': [
                {'type': 'output_text', 'text': 'Answer', 'annotations': []}]}]}
        return {'choices': [{'message': {'content': 'Answer'}}]}

    async def complete(self, provider, request, stream):
        if stream:
            return [event async for event in provider.stream(request)][-1].completion
        return await provider.complete(request)

    async def test_strict_supported_for_both_apis_and_custom_models(self):
        for api in ('responses', 'chat_completions'):
            for stream in (False, True):
                def handler(request):
                    payload = json.loads(request.content)
                    function = payload['tools'][0].get('function', payload['tools'][0])
                    self.assertTrue(function['strict'])
                    self.assertEqual(function['parameters']['required'], ['path', 'startLine', 'endLine'])
                    self.assertIn({'type': 'null'}, function['parameters']['properties']['startLine']['anyOf'])
                    return httpx.Response(200, json=self.answer(api))
                provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
                self.assertEqual((await self.complete(provider, self.request(api), stream)).content, 'Answer')

    async def test_explicit_strict_rejection_falls_back_once_and_is_remembered(self):
        for api in ('responses', 'chat_completions'):
            for message in ("Strict function tools are not supported by this model.",
                            "Unknown parameter: tools[0].strict", "Unsupported parameter: 'tools[0].strict'."):
                for stream in (False, True):
                    sent = []
                    def handler(request):
                        payload = json.loads(request.content)
                        sent.append(payload)
                        function = payload['tools'][0].get('function', payload['tools'][0])
                        if function.get('strict') is True:
                            return httpx.Response(400, json={'error': {'message': message}})
                        if 'parameter' in message or api == 'chat_completions':
                            self.assertNotIn('strict', function)
                        self.assertEqual(function['parameters'], TOOLS['read_file'].parameters)
                        self.assertEqual(payload.get('reasoning', {}).get('effort', payload.get('reasoning_effort')), 'high')
                        return httpx.Response(200, json=self.answer(api))
                    provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
                    for _ in range(2):
                        await self.complete(provider, self.request(api), stream)
                    self.assertEqual(len(sent), 3)

    async def test_strict_and_temperature_rejections_do_not_repeat_on_next_turn(self):
        sent = []
        def handler(request):
            payload = json.loads(request.content)
            sent.append(payload)
            if payload['tools'][0].get('strict') is True:
                return httpx.Response(400, json={'error': {'message': "Invalid schema: 'minItems' is not permitted."}})
            if 'temperature' in payload:
                return httpx.Response(400, json={'error': {'message': 'Unsupported parameter: temperature'}})
            return httpx.Response(200, json=self.answer('responses'))
        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        for _ in range(2):
            await self.complete(provider, self.request(), True)
        self.assertEqual(len(sent), 4)

    async def test_other_errors_do_not_weaken_schemas(self):
        for status, message in ((400, 'Invalid schema: a required field is missing'), (400, 'Unsupported reasoning effort'),
                                (401, 'Strict tools are not supported'), (429, 'Rate limited')):
            sent = []
            def handler(request):
                sent.append(json.loads(request.content))
                return httpx.Response(status, json={'error': {'message': message}})
            provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
            with self.assertRaises(ProviderError):
                await self.complete(provider, self.request(), True)
            self.assertEqual(len(sent), 1)

    async def test_cached_fallback_preserves_a_final_request_without_tools(self):
        for api in ('responses', 'chat_completions'):
            sent = []
            def handler(request):
                payload = json.loads(request.content)
                sent.append(payload)
                if len(sent) == 1:
                    return httpx.Response(400, json={'error': {'message': 'Strict tools are not supported'}})
                if len(sent) == 3:
                    self.assertNotIn('tools', payload)
                return httpx.Response(200, json=self.answer(api))
            provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
            request = self.request(api)
            await provider.complete(request)
            await provider.complete(replace(request, tools=()))
            self.assertEqual(len(sent), 3)

    async def test_compatibility_cache_is_scoped_to_model_and_endpoint(self):
        requests = []
        def handler(request):
            payload = json.loads(request.content)
            requests.append(payload)
            if len(requests) == 1:
                return httpx.Response(400, json={'error': {'message': 'Strict tools are not supported'}})
            return httpx.Response(200, json=self.answer('responses'))
        provider = OpenAICompatibleProvider(transport=httpx.MockTransport(handler))
        request = self.request()
        await provider.complete(request)
        await provider.complete(replace(request, model='another-model'))
        await provider.complete(replace(request, base_url='https://another.example/v1'))
        self.assertTrue(requests[-2]['tools'][0]['strict'])
        self.assertTrue(requests[-1]['tools'][0]['strict'])


if __name__ == '__main__':
    unittest.main()
