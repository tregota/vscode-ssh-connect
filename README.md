# Description

Simple SSH tunneling tool.
Uses mscdex's pure JavaScript SSH2 client to try and make a simple PuTTY or MobaXterm alternative within vscode.

# Example Config
```
{
  "ssh-connect.connections": [
    {
      "folder": "stuff",
      "iconPath": "C:\\Users\\user\\Pictures\\Company.png",
      "blabla": "A connection without id can be used to set a folder icon or define defaults for connections within the same folder"
    },
    {
      "id": "server",
      "folder": "stuff",
      "host": "192.168.1.123",
      "username": "user",
      "password": "apassword",
      "port": 22,
      "portForwards": [
        {
          "srcPort": 443,
          "dstAddr": "10.0.0.12",
          "dstPort": 443,
          "autoConnect": false,
          "link": "https",
          "blabla": "Setting a port forward type will show a context button for opening the adress in e.g. a browser"
        }
      ]
    },
    {
      "id": "behind-server",
      "folder": "stuff",
      "host": "10.0.0.12",
      "port": 22,
      "username": "anotheruser",
      "jumpServer": "server",
      "blabla": "jumpServer references only work within the folder"
    },
  ],
  "ssh-connect.configurations": [
    {
      "type": "file",
      "path": "C:\\Users\\user\\.ssh\\configs.json"
    },
    {
      "type": "sftp",
      "connection": "stuff/server",
      "path": "/home/pi/configs.json",
      "autoConnect": false,
      "blabla": "connections defined in an external config file of type sftp will be added after you first connect unless autoConnect is on."
    }
  ]
}
```