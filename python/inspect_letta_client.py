#!/usr/bin/env python3
"""
Inspect the letta-client package structure to understand how it works
"""
import sys
import inspect
import importlib

try:
    import letta_client
    print(f"✓ Found letta_client at: {letta_client.__file__}")
    print(f"\n=== Module Structure ===")
    print(f"Module attributes: {[a for a in dir(letta_client) if not a.startswith('_')][:30]}")
    
    # Check for AsyncLetta
    if hasattr(letta_client, 'AsyncLetta'):
        print(f"\n=== AsyncLetta Class ===")
        AsyncLetta = letta_client.AsyncLetta
        print(f"AsyncLetta location: {inspect.getfile(AsyncLetta)}")
        print(f"AsyncLetta methods: {[m for m in dir(AsyncLetta) if not m.startswith('_')][:20]}")
        
        # Try to create an instance to inspect
        try:
            client = AsyncLetta(base_url='http://test')
            print(f"\n=== AsyncLetta Instance ===")
            print(f"Instance attributes: {[a for a in dir(client) if not a.startswith('_')][:20]}")
            
            # Check agents
            if hasattr(client, 'agents'):
                agents = client.agents
                print(f"\n=== agents attribute ===")
                print(f"agents type: {type(agents)}")
                print(f"agents location: {inspect.getfile(type(agents)) if hasattr(type(agents), '__file__') else 'N/A'}")
                print(f"agents attributes: {[a for a in dir(agents) if not a.startswith('_')][:20]}")
                
                # Check messages
                if hasattr(agents, 'messages'):
                    messages = agents.messages
                    print(f"\n=== messages attribute ===")
                    print(f"messages type: {type(messages)}")
                    print(f"messages location: {inspect.getfile(type(messages)) if hasattr(type(messages), '__file__') else 'N/A'}")
                    print(f"messages attributes: {[a for a in dir(messages) if not a.startswith('_')][:20]}")
                    
                    # Check create method
                    if hasattr(messages, 'create'):
                        create = messages.create
                        print(f"\n=== create method ===")
                        print(f"create type: {type(create)}")
                        print(f"create is method: {inspect.ismethod(create)}")
                        print(f"create is function: {inspect.isfunction(create)}")
                        print(f"create is bound: {hasattr(create, '__self__')}")
                        if hasattr(create, '__func__'):
                            print(f"create.__func__: {create.__func__}")
                            print(f"create.__func__ location: {inspect.getfile(create.__func__) if hasattr(create.__func__, '__file__') else 'N/A'}")
                        try:
                            sig = inspect.signature(create)
                            print(f"create signature: {sig}")
                        except Exception as e:
                            print(f"Could not get signature: {e}")
        except Exception as e:
            print(f"Could not create instance: {e}")
            import traceback
            traceback.print_exc()
    
    # Check base client
    if hasattr(letta_client, '_base_client'):
        print(f"\n=== Base Client ===")
        base_client = letta_client._base_client
        print(f"Base client location: {inspect.getfile(base_client) if hasattr(base_client, '__file__') else 'N/A'}")
        print(f"Base client attributes: {[a for a in dir(base_client) if not a.startswith('_')][:20]}")
        
except ImportError as e:
    print(f"✗ Could not import letta_client: {e}")
    print("\nTrying to find where it might be installed...")
    import site
    for path in site.getsitepackages():
        print(f"  Checking: {path}")
