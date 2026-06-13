"""Stable fixture for chunking compatibility snapshot test (M018).

Do not modify this file — it is locked as a reference for chunk-boundary regression detection.
"""


def parse_config(path):
    with open(path) as f:
        return f.read()


def validate(config):
    if not config:
        raise ValueError("empty config")
    return True


class ConfigLoader:
    def load(self, path):
        return parse_config(path)

    def validate(self, config):
        return validate(config)
