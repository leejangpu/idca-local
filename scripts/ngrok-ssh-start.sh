#!/bin/bash
# ngrok TCP 터널 (SSH 포트 22) 시작 스크립트
exec ngrok tcp 22 --log=stdout
