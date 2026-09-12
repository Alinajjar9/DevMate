function providerState(callId = 'call-one') {
  return {
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'reasoning-model',
    outputItems: [
      { id: 'rs_one', type: 'reasoning', summary: [], encrypted_content: 'opaque-encrypted-reasoning' },
      {
        id: 'msg_one', type: 'message', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: 'I will inspect the file.', annotations: [] }]
      },
      { id: 'fc_one', type: 'function_call', call_id: callId, name: 'read_file', arguments: '{"path":"app.ts"}' }
    ]
  };
}

module.exports = { providerState };
