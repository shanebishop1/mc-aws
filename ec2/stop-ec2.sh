#!/usr/bin/env bash
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
aws ec2 stop-instances --instance-ids $INSTANCE_ID
