// A Host that fails before it can listen: the parent must report this at once
// with the captured stderr instead of waiting out the full socket timeout.
process.stderr.write('boom from fixture\n')
process.exit(3)
