# known bugs

## High priority
- api keys can be sent over unencrypted http. custom profiles accept remote http:// addresses, and the backend sends the key to them.

## Normal priority
- malformed bad backend responses are accepted this can cause blank answers or runtime errors instead of reporting an invalid backend response.
- backend identity and version are ignored: the extension only checks whether health returned status: "ok". it does not verify data.backend or the backend version. this can cause compatability issues.
- intellegience selector appears on models that sometimes dont support it
- intellegience selector doesnt work on models that support it
- question and path sizes are unbounded in chatbox
- agent tool loop may trigger in some cases(model specific sometimes)
- some models return final answers instnatly instead of triggering tool loop (was with deepseek v4 pro did a temporary fix speicifcally for that model)
- viewport can get too cramped on smaller screens. tested on my laptop and the chat was too cramped.
