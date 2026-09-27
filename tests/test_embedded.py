import json

from pocketaces.extract.embedded import (
    devalue_unflatten, flight_text_chunks, iter_json_objects, next_flight_text, resolve_ref,
)


def test_devalue_unflatten():
    # {"data": Reactive({"a": [1, "x"]}), "e": EmptyRef("null")}
    arr = [{"data": 1, "e": 5}, ["Reactive", 2], {"a": 3}, [4, 6], 1, ["EmptyRef", "null"], "x"]
    assert devalue_unflatten(arr) == {"data": {"a": [1, "x"]}, "e": None}


def test_flight_objects_and_text_chunks():
    body = 'a:T5,hello1b:["$","div",{"product_name":"X","url_alias":"/p/x","attributes":[]}]\n'
    html = f'<script>self.__next_f.push([1,{json.dumps(body)}])</script>'
    flight = next_flight_text(html)
    objs = list(iter_json_objects(flight, '"attributes":['))
    assert objs == [{"product_name": "X", "url_alias": "/p/x", "attributes": []}]
    chunks = flight_text_chunks(flight)
    assert chunks == {"a": "hello"}
    assert resolve_ref("$a", chunks) == "hello"
    assert resolve_ref("$undefined", chunks) is None
